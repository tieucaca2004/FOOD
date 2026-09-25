import { MerchantModule } from "../MerchantModule.js";
import { stripAccents } from "../../../src/nlp/normalize.js";
import { classifyIntent } from "../../../src/nlp/intentEngine.js"; // pure, read-only reuse
import { parseItemRequest, resolveItemRequest, parseQuantityChange, parseRemoval, matchByName } from "../../nlp/genericOrderText.js";

const MAX_CHOICES_SHOWN = 10;

function vnd(amount) {
  return `${Number(amount).toLocaleString("vi-VN")}đ`;
}

// A cart's identity + exact contents. Confirmation is only accepted for
// the very cart state the customer was last shown a summary of.
function cartSignature(cart) {
  return `${cart.id}|${cart.items.map((i) => `${i.product_id}:${i.quantity}:${i.unit_price}`).join(",")}`;
}

const ERROR_REPLIES = {
  PRODUCT_UNAVAILABLE: "Dạ món này hiện tạm hết, anh/chị chọn món khác giúp em nha.",
  PRODUCT_NOT_FOUND: "Dạ em không tìm thấy món này trong menu quán.",
  INVALID_QUANTITY: "Dạ số lượng chưa hợp lệ, anh/chị nhập số lượng từ 1 đến 50 giúp em nha.",
  CART_ITEM_LIMIT_EXCEEDED: "Dạ giỏ hàng đã đạt số món tối đa.",
  PRICE_CHANGED: "Dạ giá một số món vừa thay đổi, anh/chị xem lại giỏ (gõ \"xem giỏ\") rồi đặt lại giúp em nha.",
  MERCHANT_NOT_ACTIVE: "Dạ quán này hiện không nhận đơn.",
  CART_EMPTY: "Dạ giỏ hàng đang trống.",
  ORDER_ALREADY_EXISTS_FOR_CART: "Dạ giỏ này đã được đặt thành đơn rồi ạ.",
};

/**
 * Data-driven merchant implementation for a merchant that has no dedicated
 * code module — its catalog lives in merchant_products/merchant_categories
 * (platform DB) and its cart/order live in the platform's own generic
 * orders tables. This is what spec §31 means by "thêm merchant B chỉ cần
 * create/seed/activate — không sửa code platform".
 *
 * Phase 3 cutover: menu/product reads go through MenuService and merchant
 * record reads go through MerchantDataService (same access-boundary
 * pattern as Phase 1/2 — no repository accessed directly here anymore).
 */
export class GenericMerchantAdapter extends MerchantModule {
  // cartService/orderService are optional: without them the adapter keeps
  // the original menu-only behavior (see handleMessage).
  constructor({ merchantId, menuService, merchantDataService, cartService = null, orderService = null }) {
    super();
    this._merchantId = merchantId;
    this.menuService = menuService;
    this.merchantDataService = merchantDataService;
    this.cartService = cartService;
    this.orderService = orderService;
    // customerId -> cartSignature of the summary last shown by "đặt món".
    // In-memory only: after a restart the customer just sees the summary
    // again before confirming, which is the safe direction.
    this._pendingConfirmation = new Map();
  }

  get merchantId() {
    return this._merchantId;
  }

  async searchProducts(queryText) {
    // A DRAFT/ARCHIVED menu never surfaces in discovery/search — this is
    // the only place that check lives; DiscoveryEngine itself is
    // unchanged and simply sees "no matches" for such a merchant.
    if (!this.menuService.isMenuVisible(this._merchantId)) return [];

    const query = stripAccents(queryText || "");
    const products = this.menuService.listProducts(this._merchantId, { includeUnavailable: true });

    return products
      .map((p) => {
        const nameNorm = stripAccents(p.name);
        const keywordNorms = p.keywords.map(stripAccents);
        let matchQuality = null;
        if (nameNorm === query || keywordNorms.includes(query)) matchQuality = "exact";
        else if (keywordNorms.some((k) => query.includes(k))) matchQuality = "keyword";
        else if (query.length >= 3 && nameNorm.includes(query)) matchQuality = "category";
        return matchQuality ? { productId: p.id, name: p.name, price: p.price, available: p.available, matchQuality } : null;
      })
      .filter(Boolean);
  }

  async getMenuSummary() {
    const merchant = this.merchantDataService.getById(this._merchantId);
    const products = this.menuService.listProducts(this._merchantId, { includeUnavailable: false });
    return {
      name: merchant.name,
      address: merchant.address,
      items: products.map((p) => ({ name: p.name, price: p.price, available: p.available })),
    };
  }

  // Chat-driven cart/order on top of the shared generic Cart + Order
  // engines (CartService/OrderService, used unmodified). Intent comes from
  // A Tiểu's pure classifyIntent(); product/quantity from genericOrderText.
  // Prices are never taken from text — CartService reads them from the menu.
  async handleMessage(platformCustomerId, text) {
    if (!this.cartService || !this.orderService) {
      return this._reply(
        "Dạ quán này hiện chỉ hỗ trợ xem menu qua Tổng Đài, chưa đặt món trực tiếp được — anh/chị vui lòng gọi trực tiếp cho quán nha."
      );
    }

    const { intent } = classifyIntent(text);
    try {
      switch (intent) {
        case "add_to_cart":
          return this._addItem(platformCustomerId, text);
        case "show_cart":
          return this._reply(this._cartText(this._cart(platformCustomerId)));
        case "update_cart":
          return this._changeQuantity(platformCustomerId, text);
        case "remove_from_cart":
          return this._removeItem(platformCustomerId, text);
        case "clear_cart":
          this.cartService.clearCart(platformCustomerId, this._cart(platformCustomerId).id);
          return this._reply("Dạ em đã xóa hết giỏ hàng.");
        case "checkout":
          return this._reviewOrder(platformCustomerId);
        case "confirm_order":
          return this._confirmOrder(platformCustomerId);
        case "cancel_order":
          this._pendingConfirmation.delete(platformCustomerId);
          return this._reply("Dạ em đã hủy bước chốt đơn, giỏ hàng vẫn được giữ nguyên ạ.");
        case "show_menu":
          return this._reply(await this._menuText());
        case "product_price":
          return this._priceOf(text);
        case "store_location": {
          const merchant = this.merchantDataService.getById(this._merchantId);
          return this._reply(merchant.address ? `📍 ${merchant.address}` : "Dạ quán chưa cập nhật địa chỉ.");
        }
        default:
          // "tăng pizza hải sản lên 3" — no classifyIntent rule for tăng/giảm.
          if (parseQuantityChange(text)) return this._changeQuantity(platformCustomerId, text);
          // "2 pizza hải sản" — a leading quantity with no verb is still an add.
          if (parseItemRequest(text).quantity !== null) return this._addItem(platformCustomerId, text);
          return this._reply(this._helpText());
      }
    } catch (err) {
      const known = ERROR_REPLIES[err.code];
      if (!known) throw err;
      return this._reply(known);
    }
  }

  _reply(replyText, merchantIntent = null, orderRef = null) {
    return { replyText, merchantIntent, orderRef };
  }

  _cart(customerId) {
    return this.cartService.getOrCreateCart(customerId, this._merchantId);
  }

  _orderableProducts() {
    return this.menuService.listProducts(this._merchantId, { includeUnavailable: false });
  }

  _choicesText(candidates, hint) {
    const shown = candidates.slice(0, MAX_CHOICES_SHOWN).map((p) => `• ${p.name || p.product_name}`);
    const more = candidates.length > MAX_CHOICES_SHOWN ? `\n… và ${candidates.length - MAX_CHOICES_SHOWN} món khác` : "";
    return `Dạ có ${candidates.length} món phù hợp, anh/chị ghi rõ tên món giúp em:\n${shown.join("\n")}${more}\n\n${hint}`;
  }

  _addItem(customerId, text) {
    const { quantity, query, match, candidates } = resolveItemRequest(text, this._orderableProducts());
    if (!query) return this._reply('Anh/chị muốn thêm món nào ạ? (VD: "thêm 2 pizza hải sản")');

    if (!match) {
      if (candidates.length > 1) return this._reply(this._choicesText(candidates, 'VD: "thêm 1 Seafood Pizza"'));
      return this._reply(`Dạ em không tìm thấy món "${query}" trong menu quán. Gõ "menu" để xem danh sách món nha.`);
    }

    const cart = this._cart(customerId);
    const updated = this.cartService.addItem(customerId, cart.id, this._merchantId, match.id, quantity ?? 1);
    const line = updated.items.find((i) => i.product_id === match.id);
    return this._reply(
      `✅ Đã thêm ${quantity ?? 1} × ${match.name} (${vnd(match.price)})\nTrong giỏ: ${line.quantity} × ${match.name}\n\n${this._cartText(updated)}`,
      "add_to_cart"
    );
  }

  _findCartLine(cart, query) {
    return matchByName(
      query,
      cart.items.map((i) => ({ ...i, name: i.product_name }))
    );
  }

  _changeQuantity(customerId, text) {
    const change = parseQuantityChange(text);
    if (!change || !change.query || change.quantity === null) {
      return this._reply('Dạ anh/chị ghi giúp em theo dạng: "đổi pizza hải sản thành 3" hoặc "tăng pizza hải sản lên 3".');
    }
    const cart = this._cart(customerId);
    const { match, candidates } = this._findCartLine(cart, change.query);
    if (!match) {
      if (candidates.length > 1) return this._reply(this._choicesText(candidates, 'VD: "đổi Seafood Pizza thành 3"'));
      return this._reply(`Dạ trong giỏ chưa có món "${change.query}".\n\n${this._cartText(cart)}`);
    }
    const updated = this.cartService.updateItemQuantity(customerId, cart.id, match.id, change.quantity);
    const done = change.quantity === 0 ? `🗑 Đã bỏ ${match.product_name}` : `✏️ Đã đổi ${match.product_name} thành ${change.quantity}`;
    return this._reply(`${done}\n\n${this._cartText(updated)}`);
  }

  _removeItem(customerId, text) {
    const query = parseRemoval(text);
    const cart = this._cart(customerId);
    const { match, candidates } = query ? this._findCartLine(cart, query) : { match: null, candidates: [] };
    if (!match) {
      if (candidates.length > 1) return this._reply(this._choicesText(candidates, 'VD: "bỏ Seafood Pizza"'));
      return this._reply(`Dạ trong giỏ chưa có món "${query}".\n\n${this._cartText(cart)}`);
    }
    const updated = this.cartService.removeItem(customerId, cart.id, match.id);
    return this._reply(`🗑 Đã bỏ ${match.product_name}\n\n${this._cartText(updated)}`);
  }

  _reviewOrder(customerId) {
    const cart = this._cart(customerId);
    if (cart.isEmpty) return this._reply('Dạ giỏ hàng đang trống, anh/chị thêm món trước nha (VD: "thêm 1 pizza hải sản").');
    this._pendingConfirmation.set(customerId, cartSignature(cart));
    return this._reply(
      `Anh/chị kiểm tra lại đơn giúp em:\n\n${this._cartText(cart)}\n\nGõ "xác nhận" để chốt đơn, hoặc tiếp tục thêm/đổi món.`,
      "checkout"
    );
  }

  async _confirmOrder(customerId) {
    const cart = this._cart(customerId);
    if (cart.isEmpty) return this._reply("Dạ giỏ hàng đang trống, chưa có gì để chốt ạ.");
    // Never create an order from a bare "ok" the customer didn't aim at
    // this exact cart: no summary shown yet, or the cart changed since.
    if (this._pendingConfirmation.get(customerId) !== cartSignature(cart)) return this._reviewOrder(customerId);

    const order = await this.orderService.confirmOrder(customerId, cart.id);
    this._pendingConfirmation.delete(customerId);
    const lines = order.items.map((i) => `• ${i.quantity} × ${i.product_name} = ${vnd(i.line_total)}`);
    const delivery =
      order.status === "SENT_TO_MERCHANT"
        ? "Đơn đã được gửi tới quán."
        : "Lưu ý: đơn đã được ghi nhận nhưng CHƯA được gửi tới quán — Tổng Đài chưa có kênh gửi đơn tự động cho quán này.";
    return this._reply(
      `✅ Đã tạo đơn ${order.order_code}\n${lines.join("\n")}\nTổng: ${vnd(order.total)}\n\n${delivery}`,
      "confirm_order",
      order.order_code
    );
  }

  _priceOf(text) {
    const { query } = parseItemRequest(text);
    const { match, candidates } = matchByName(query, this._orderableProducts());
    if (match) return this._reply(`${match.name}: ${vnd(match.price)}`);
    if (candidates.length > 1) {
      return this._reply(candidates.slice(0, MAX_CHOICES_SHOWN).map((p) => `• ${p.name}: ${vnd(p.price)}`).join("\n"));
    }
    return this._reply(`Dạ em không tìm thấy món "${query}" trong menu quán.`);
  }

  _cartText(cart) {
    if (cart.isEmpty) return "🛒 Giỏ hàng đang trống.";
    const lines = cart.items.map((i) => `• ${i.quantity} × ${i.product_name} = ${vnd(i.subtotal)}`);
    return `🛒 Giỏ hàng:\n${lines.join("\n")}\nTạm tính: ${vnd(cart.total)}`;
  }

  async _menuText() {
    const menu = await this.getMenuSummary();
    return `${menu.name}\n\n${menu.items.map((i) => `🍽 ${i.name}: ${vnd(i.price)}`).join("\n")}`;
  }

  _helpText() {
    return [
      "Dạ anh/chị có thể nhắn:",
      '• "menu" — xem thực đơn',
      '• "thêm 2 pizza hải sản" — thêm món',
      '• "xem giỏ" — xem giỏ hàng',
      '• "đổi pizza hải sản thành 3" / "bỏ coca" — sửa giỏ',
      '• "đặt món" rồi "xác nhận" — chốt đơn',
      '• "quay lại tổng đài" — tìm quán khác',
    ].join("\n");
  }

  isOpenNow() {
    return { known: false };
  }
}
