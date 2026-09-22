import { classifyIntent } from "../nlp/intentEngine.js";
import { extractQuantity } from "../nlp/normalize.js";
import { parseFulfillmentType, parsePhone, fulfillmentTypeLabel } from "../domain/checkoutFields.js";
import { CartError } from "../services/cartService.js";
import { OrderError } from "../services/orderService.js";
import { logger } from "../logger.js";

const AFFIRMATIVE = /(xác nhận|đồng ý|^ok$|chốt|đúng rồi|chuẩn rồi|^ừ$|^được$|đặt)/;
const NEGATIVE = /(hủy|không đặt|thôi)/;

const CART_ERROR_MESSAGES = {
  INVALID_QUANTITY: "Số lượng không hợp lệ, anh/chị cho em số lượng cụ thể nha.",
  PRODUCT_NOT_FOUND: "Em chưa tìm thấy món này trong menu.",
  PRODUCT_UNAVAILABLE: "Món này hiện đang tạm hết.",
  ITEM_NOT_FOUND: "Món này không có trong giỏ hàng.",
};

function disambiguationReply(candidates) {
  const names = candidates.map((c) => c.name);
  const last = names.pop();
  return `Anh/chị muốn ${names.join(", ")}${names.length ? " hay " : ""}${last} ạ?`;
}

function resolveProduct(menu, text) {
  return menu.findProductMatches(text);
}

export class BusinessRouter {
  constructor(services, ai) {
    this.services = services;
    this.ai = ai;
  }

  async handle({ customer, session, text }) {
    const { intent: baseIntent } = classifyIntent(text);
    const lower = text.trim().toLowerCase();

    // Contextual overrides take priority over the raw classifier — the
    // session is what disambiguates "Xác nhận" (confirm this order) from a
    // cold, out-of-context message.
    if (session.pending_confirmation) {
      // Negative check first: "đặt" is also an affirmative trigger word, but
      // "thôi không đặt nữa" must cancel, not confirm.
      if (NEGATIVE.test(lower)) {
        return this._cancelOrder(customer, session);
      }
      if (AFFIRMATIVE.test(lower) && baseIntent !== "add_to_cart") {
        return this._confirmOrder(customer, session);
      }
      if (["add_to_cart", "remove_from_cart", "update_cart", "show_cart", "clear_cart"].includes(baseIntent)) {
        await this._supersedePendingOrder(session, "cart changed while awaiting confirmation");
        session = this.services.sessions.clearPending(session.id);
      }
    }

    if (session.pending_checkout_field && !["cancel_order", "human_support"].includes(baseIntent)) {
      const isCartEdit = ["add_to_cart", "remove_from_cart", "update_cart", "show_cart", "clear_cart"].includes(
        baseIntent
      );
      if (isCartEdit) {
        await this._supersedePendingOrder(session, "cart changed during checkout");
        session = this.services.sessions.clearPending(session.id);
      } else {
        return this._handleCheckoutAnswer(customer, session, text);
      }
    }

    return this._routeIntent(baseIntent, customer, session, text);
  }

  async _routeIntent(intent, customer, session, text) {
    switch (intent) {
      case "greeting":
        return this._reply(session, "greeting", this._greetingText());
      case "show_menu":
        return this._showMenuOrProduct(customer, session, text);
      case "product_question":
        return this._productDetail(session, text);
      case "product_price":
        return this._productPrice(session, text);
      case "product_availability":
        return this._productAvailability(session, text);
      case "add_to_cart":
        return this._addToCart(customer, session, text);
      case "remove_from_cart":
        return this._removeFromCart(customer, session, text);
      case "update_cart":
        return this._updateCart(customer, session, text);
      case "show_cart":
        return this._showCart(customer, session);
      case "clear_cart":
        return this._clearCart(customer, session);
      case "checkout":
        return this._startCheckout(customer, session);
      case "confirm_order":
        return this._confirmOrder(customer, session);
      case "cancel_order":
        return this._cancelOrder(customer, session);
      case "order_status":
        return this._orderStatus(customer, session);
      case "store_location":
        return this._settingReply(session, "store_location", "store_address", "Dạ quán chưa cập nhật địa chỉ, anh/chị gọi trực tiếp giúp em nha.");
      case "opening_hours":
        return this._settingReply(session, "opening_hours", "opening_hours", "Dạ quán chưa cập nhật giờ mở cửa.");
      case "payment_method":
        return this._settingReply(session, "payment_method", "payment_methods", "Dạ quán chưa cập nhật phương thức thanh toán.");
      case "delivery_question":
        return this._deliveryInfo(session);
      case "promotion_question":
        return this._promotionInfo(session);
      case "human_support":
        return this._reply(session, "human_support", "Dạ em chuyển thông tin cho nhân viên hỗ trợ trực tiếp nha, anh/chị chờ chút ạ.");
      default:
        return this._unknown(session, text);
    }
  }

  _greetingText() {
    return [
      "Dạ em chào anh/chị, em là Mary — hỗ trợ đặt món tại Hủ Tiếu Xào A Tiểu qua Zalo.",
      "",
      "🍜 Xem Menu — gõ \"menu\"",
      "🛒 Giỏ Hàng — gõ \"xem giỏ\"",
      "📦 Đặt Món — gõ \"đặt\"",
      "📍 Địa Chỉ — gõ \"địa chỉ quán\"",
      "☎️ Gọi Quán — gõ \"số điện thoại quán\"",
    ].join("\n");
  }

  async _showMenuOrProduct(customer, session, text) {
    const match = resolveProduct(this.services.menu, text);
    if (match.exact) return this._productDetail(session, text, match);
    if (match.candidates.length > 1) return this._reply(session, "show_menu", disambiguationReply(match.candidates));
    return this._reply(session, "show_menu", this.services.menu.formatMenuText());
  }

  async _productDetail(session, text, precomputed) {
    const match = precomputed || resolveProduct(this.services.menu, text);
    if (match.exact) return this._reply(session, "product_question", this.services.menu.formatProductDetail(match.exact));
    if (match.candidates.length > 1) return this._reply(session, "product_question", disambiguationReply(match.candidates));
    return this._reply(session, "product_question", "Em chưa tìm thấy món này trong menu.");
  }

  async _productPrice(session, text) {
    const match = resolveProduct(this.services.menu, text);
    if (match.exact) {
      const p = match.exact;
      return this._reply(
        session,
        "product_price",
        p.available ? `${p.name}: giá ${formatVndInline(p.price)}.` : `${p.name} hiện đang tạm hết.`
      );
    }
    if (match.candidates.length > 1) return this._reply(session, "product_price", disambiguationReply(match.candidates));
    return this._reply(session, "product_price", "Em chưa tìm thấy món này trong menu.");
  }

  async _productAvailability(session, text) {
    const match = resolveProduct(this.services.menu, text);
    if (match.exact) {
      return this._reply(
        session,
        "product_availability",
        match.exact.available ? `${match.exact.name} hiện vẫn còn ạ.` : `${match.exact.name} hiện đang tạm hết ạ.`
      );
    }
    if (match.candidates.length > 1) return this._reply(session, "product_availability", disambiguationReply(match.candidates));
    return this._reply(session, "product_availability", "Em chưa tìm thấy món này trong menu.");
  }

  async _addToCart(customer, session, text) {
    const match = resolveProduct(this.services.menu, text);
    if (match.candidates.length > 1) return this._reply(session, "add_to_cart", disambiguationReply(match.candidates));
    if (!match.exact) return this._reply(session, "add_to_cart", CART_ERROR_MESSAGES.PRODUCT_NOT_FOUND);

    const quantity = extractQuantity(text) ?? 1;
    try {
      const { items, total } = this.services.cart.addItem(customer.id, match.exact.id, quantity);
      const addedLine = items.find((i) => i.product_id === match.exact.id);
      const msg = `Đã thêm: ${addedLine.product_name} × ${addedLine.quantity}\n\n${this.services.cart.formatCartSummary({ items, total })}`;
      return this._reply(session, "add_to_cart", msg);
    } catch (err) {
      if (err instanceof CartError) return this._reply(session, "add_to_cart", CART_ERROR_MESSAGES[err.code] || err.message);
      throw err;
    }
  }

  async _removeFromCart(customer, session, text) {
    const match = resolveProduct(this.services.menu, text);
    if (match.candidates.length > 1) return this._reply(session, "remove_from_cart", disambiguationReply(match.candidates));
    if (!match.exact) return this._reply(session, "remove_from_cart", CART_ERROR_MESSAGES.PRODUCT_NOT_FOUND);

    try {
      const { items, total } = this.services.cart.removeItemByProduct(customer.id, match.exact.id);
      const msg = `Đã bỏ ${match.exact.name} khỏi giỏ.\n\n${this.services.cart.formatCartSummary({ items, total })}`;
      return this._reply(session, "remove_from_cart", msg);
    } catch (err) {
      if (err instanceof CartError) return this._reply(session, "remove_from_cart", CART_ERROR_MESSAGES[err.code] || err.message);
      throw err;
    }
  }

  async _updateCart(customer, session, text) {
    const match = resolveProduct(this.services.menu, text);
    if (match.candidates.length > 1) return this._reply(session, "update_cart", disambiguationReply(match.candidates));
    if (!match.exact) return this._reply(session, "update_cart", CART_ERROR_MESSAGES.PRODUCT_NOT_FOUND);

    const quantity = extractQuantity(text);
    if (!quantity) return this._reply(session, "update_cart", "Anh/chị muốn đổi thành số lượng bao nhiêu ạ?");

    try {
      const { cart } = this.services.cart.getCart(customer.id);
      const existing = this.services.cart.repos.carts.findItemByProduct(cart.id, match.exact.id);
      if (!existing) return this._reply(session, "update_cart", CART_ERROR_MESSAGES.ITEM_NOT_FOUND);
      const { items, total } = this.services.cart.updateItemQuantity(customer.id, existing.id, quantity);
      return this._reply(session, "update_cart", this.services.cart.formatCartSummary({ items, total }));
    } catch (err) {
      if (err instanceof CartError) return this._reply(session, "update_cart", CART_ERROR_MESSAGES[err.code] || err.message);
      throw err;
    }
  }

  async _showCart(customer, session) {
    const cart = this.services.cart.getCart(customer.id);
    return this._reply(session, "show_cart", this.services.cart.formatCartSummary(cart));
  }

  async _clearCart(customer, session) {
    this.services.cart.clear(customer.id);
    return this._reply(session, "clear_cart", "Đã xóa giỏ hàng.");
  }

  async _startCheckout(customer, session) {
    const cart = this.services.cart.getCart(customer.id);
    let order;
    try {
      order = this.services.orders.startCheckout(customer, cart.cart, cart.items);
    } catch (err) {
      if (err instanceof OrderError) return this._reply(session, "checkout", err.message);
      throw err;
    }

    const missing = this.services.orders.nextMissingCheckoutField(order, customer);
    if (missing) {
      session = this.services.sessions.update(session.id, { pendingOrderId: order.id, pendingCheckoutField: missing });
      return this._reply(session, "checkout", this._checkoutQuestion(missing));
    }
    return this._finalizeCheckout(session, order, customer);
  }

  _checkoutQuestion(field) {
    if (field === "fulfillment_type") return "Anh/chị muốn ăn tại quán, mang về, hay giao hàng ạ?";
    if (field === "address") return "Anh/chị cho em địa chỉ giao hàng ạ.";
    if (field === "phone") return "Anh/chị cho em số điện thoại để liên hệ khi món sẵn sàng ạ.";
    return "Anh/chị bổ sung thêm thông tin giúp em nha.";
  }

  async _handleCheckoutAnswer(customer, session, text) {
    const order = this.services.orders.getById(session.pending_order_id);
    if (!order) {
      session = this.services.sessions.clearPending(session.id);
      return this._reply(session, "checkout", "Đơn hàng trước đã bị hủy, anh/chị gõ \"Đặt\" để bắt đầu lại nha.");
    }

    const field = session.pending_checkout_field;
    if (field === "fulfillment_type") {
      const parsed = parseFulfillmentType(text);
      if (!parsed) return this._reply(session, "checkout", "Anh/chị chọn ăn tại quán, mang về, hay giao hàng giúp em nha.");
      const deliveryFee = Number(this.services.orders.repos.settings.get("delivery_fee")) || 0;
      this.services.orders.applyCheckoutField(order, "fulfillment_type", parsed, deliveryFee);
    } else if (field === "address") {
      const value = text.trim();
      if (value.length < 5) return this._reply(session, "checkout", "Anh/chị cho em địa chỉ đầy đủ hơn giúp em nha.");
      this.services.orders.applyCheckoutField(order, "address", value);
    } else if (field === "phone") {
      const parsed = parsePhone(text);
      if (!parsed) return this._reply(session, "checkout", "Anh/chị cho em số điện thoại đúng định dạng (VD: 0912345678) giúp em nha.");
      this.services.orders.applyCheckoutField(order, "phone", parsed);
      this.services.customers.recordPhone(customer.id, parsed);
    }

    const refreshedOrder = this.services.orders.getById(order.id);
    const refreshedCustomer = this.services.customers.getById(customer.id);
    const missing = this.services.orders.nextMissingCheckoutField(refreshedOrder, refreshedCustomer);
    if (missing) {
      session = this.services.sessions.update(session.id, { pendingCheckoutField: missing });
      return this._reply(session, "checkout", this._checkoutQuestion(missing));
    }
    return this._finalizeCheckout(session, refreshedOrder, refreshedCustomer);
  }

  _finalizeCheckout(session, order, customer) {
    const pending = this.services.orders.moveToPendingConfirmation(order);
    const items = this.services.orders.repos.orders.listItems(pending.id);
    session = this.services.sessions.update(session.id, {
      pendingOrderId: pending.id,
      pendingCheckoutField: null,
      pendingConfirmation: true,
    });
    return this._reply(session, "checkout", this.services.orders.formatOrderSummary(pending, items, customer));
  }

  async _confirmOrder(customer, session) {
    if (!session.pending_confirmation || !session.pending_order_id) {
      return this._reply(session, "confirm_order", 'Hiện chưa có đơn nào đang chờ xác nhận. Anh/chị gõ "Đặt" để bắt đầu đặt món nha.');
    }
    const order = this.services.orders.getById(session.pending_order_id);
    const cart = this.services.cart.repos.carts.getById(order.cart_id);
    const confirmed = await this.services.orders.confirm(order, cart);
    session = this.services.sessions.clearPending(session.id);
    return this._reply(session, "confirm_order", `Đã xác nhận đơn hàng #${confirmed.order_code}. Quán sẽ chuẩn bị món, cảm ơn anh/chị đã đặt tại A Tiểu!`);
  }

  async _cancelOrder(customer, session) {
    const orderId = session.pending_order_id;
    if (!orderId) return this._reply(session, "cancel_order", "Hiện chưa có đơn nào để hủy.");
    const order = this.services.orders.getById(orderId);
    if (!order || ["CANCELLED", "COMPLETED"].includes(order.status)) {
      session = this.services.sessions.clearPending(session.id);
      return this._reply(session, "cancel_order", "Hiện chưa có đơn nào để hủy.");
    }
    this.services.orders.cancel(order, "customer cancelled");
    session = this.services.sessions.clearPending(session.id);
    return this._reply(session, "cancel_order", "Đã hủy đơn, anh/chị cần gì khác cứ nói với em nha.");
  }

  async _supersedePendingOrder(session, note) {
    if (!session.pending_order_id) return;
    const order = this.services.orders.getById(session.pending_order_id);
    if (order && !["CANCELLED", "COMPLETED"].includes(order.status)) {
      try {
        this.services.orders.cancel(order, note);
      } catch (err) {
        logger.warn("ORDER", "failed to supersede pending order", { orderId: order.id, error: err.message });
      }
    }
  }

  async _orderStatus(customer, session) {
    const [latest] = this.services.orders.repos.orders.listByCustomer(customer.id, 1);
    if (!latest) return this._reply(session, "order_status", "Anh/chị chưa có đơn hàng nào.");
    return this._reply(session, "order_status", `Đơn #${latest.order_code}: trạng thái ${latest.status}.`);
  }

  _settingReply(session, intent, key, fallback) {
    const value = this.services.orders.repos.settings.get(key);
    return this._reply(session, intent, value && value.trim() ? value : fallback);
  }

  _deliveryInfo(session) {
    const fee = this.services.orders.repos.settings.get("delivery_fee");
    return this._reply(
      session,
      "delivery_question",
      fee ? `Dạ quán có giao hàng, phí giao hàng ${formatVndInline(Number(fee))}.` : "Dạ thông tin giao hàng quán chưa cập nhật."
    );
  }

  _promotionInfo(session) {
    const promos = this.services.orders.repos.promotions.listActive();
    if (promos.length === 0) return this._reply(session, "promotion_question", "Dạ hiện quán chưa có khuyến mãi nào ạ.");
    const lines = promos.map((p) => `- ${p.code}: ${p.description || ""}`);
    return this._reply(session, "promotion_question", `Dạ quán đang có khuyến mãi:\n${lines.join("\n")}`);
  }

  _unknown(session, text) {
    const match = resolveProduct(this.services.menu, text);
    if (match.exact) return this._productDetail(session, text, match);
    if (match.candidates.length > 1) return this._reply(session, "unknown", disambiguationReply(match.candidates));
    return this._reply(session, "unknown", "Dạ em chưa rõ ý anh/chị, anh/chị nói rõ hơn giúp em (tên món, số lượng) nha.");
  }

  _reply(session, intent, replyText) {
    const updated = this.services.sessions.update(session.id, { currentIntent: intent });
    return { replyText, session: updated };
  }
}

function formatVndInline(amount) {
  return `${Number(amount).toLocaleString("vi-VN")}đ`;
}
