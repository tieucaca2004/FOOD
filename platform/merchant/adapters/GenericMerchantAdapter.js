import { MerchantModule } from "../MerchantModule.js";
import { stripAccents } from "../../../src/nlp/normalize.js";
import { parseGenericOrderMessage } from "../../nlp/genericOrderIntent.js";
import { platformConfig } from "../../config.js";

const money = (amount) => `${Number(amount).toLocaleString("vi-VN")}đ`;

// Customer-facing replies for the domain errors CartService/OrderService
// raise on a chat action. Anything not listed is unexpected and propagates.
const ERROR_REPLIES = {
  INVALID_QUANTITY: () => `Số lượng không hợp lệ: mỗi món từ 1 đến ${platformConfig.cartMaxItemQuantity} phần ạ.`,
  CART_ITEM_LIMIT_EXCEEDED: () => "Dạ giỏ hàng đã đủ số món tối đa, anh/chị đặt đơn này trước giúp em nha.",
  PRODUCT_UNAVAILABLE: () => "Dạ có món hiện đang tạm hết hoặc menu quán đang tạm đóng, anh/chị xem lại menu giúp em nha.",
  PRODUCT_NOT_FOUND: () => "Dạ có món trong giỏ không còn trong menu, anh/chị gõ \"xóa giỏ hàng\" rồi chọn lại giúp em nha.",
  PRICE_CHANGED: () => "Dạ giá một món trong giỏ vừa thay đổi, anh/chị gõ \"xóa giỏ hàng\" rồi chọn lại để thấy giá mới nha.",
  MERCHANT_NOT_ACTIVE: () => "Dạ quán này hiện không khả dụng, anh/chị tìm quán khác giúp em nha.",
  ORDER_ALREADY_EXISTS_FOR_CART: () => "Dạ đơn cho giỏ hàng này đã được ghi nhận rồi ạ.",
  ORDER_CODE_CONFLICT: () => "Dạ hệ thống đang bận, anh/chị gõ \"đặt hàng\" lại giúp em nha.",
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
 *
 * Chat ordering: handleMessage() reads the message with the deterministic
 * parseGenericOrderMessage() and acts through the generic CartService and
 * OrderService only. The cart is always this customer's active cart for
 * THIS merchant, so dishes of another merchant can never enter it; prices,
 * quantity limits, availability and ownership stay those services' rules.
 */
export class GenericMerchantAdapter extends MerchantModule {
  constructor({ merchantId, menuService, merchantDataService, cartService, orderService }) {
    super();
    this._merchantId = merchantId;
    this.menuService = menuService;
    this.merchantDataService = merchantDataService;
    this.cartService = cartService;
    this.orderService = orderService;
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

  async handleMessage(platformCustomerId, text) {
    const products = this.menuService.listProducts(this._merchantId, { includeUnavailable: true });
    const intent = parseGenericOrderMessage(text, products);
    try {
      return await this._act(platformCustomerId, intent, products);
    } catch (err) {
      const reply = ERROR_REPLIES[err.code];
      if (!reply) throw err;
      return { replyText: reply(), merchantIntent: null, orderRef: null };
    }
  }

  async _act(customerId, intent, products) {
    const reply = (replyText, extra = {}) => ({ replyText, merchantIntent: null, orderRef: null, ...extra });
    const available = products.filter((p) => p.available);

    switch (intent.type) {
      case "menu":
        return reply(this._menuText(available));
      case "view_cart":
        return reply(this._cartText(this._cart(customerId)));
      case "clear_cart": {
        const cart = this._cart(customerId);
        this.cartService.clearCart(customerId, cart.id);
        return reply("Đã xóa hết món trong giỏ hàng.");
      }
      case "add": {
        if (!intent.product.available) {
          return reply(`Dạ ${intent.product.name} hiện đang tạm hết, anh/chị chọn món khác giúp em nha.`);
        }
        const cart = this._cart(customerId);
        const updated = this.cartService.addItem(customerId, cart.id, this._merchantId, intent.product.id, intent.quantity);
        return reply(`Đã thêm: ${intent.product.name} × ${intent.quantity}\n\n${this._cartText(updated)}\n\n(Gõ "đặt hàng" để đặt, "xem menu" để xem thêm món)`, {
          merchantIntent: "add_to_cart",
        });
      }
      case "place_order": {
        const cart = this._cart(customerId);
        if (cart.isEmpty) return reply("Giỏ hàng đang trống, anh/chị chọn món trước giúp em nha.");
        const order = await this.orderService.confirmOrder(customerId, cart.id);
        return reply(this._orderText(order), { merchantIntent: "confirm_order", orderRef: order.order_code });
      }
      case "ambiguous":
        return reply(`Dạ anh/chị muốn món nào ạ?\n${intent.products.map((p) => `- ${p.name}`).join("\n")}`);
      case "which_item":
        return reply(`Dạ anh/chị muốn thêm món nào ạ? Gõ tên món và số lượng giúp em nha.\n\n${this._menuText(available)}`);
      case "unknown_item":
        return reply(`Dạ quán không có món này.\n\n${this._menuText(available)}`);
      default: {
        const example = available[0] ? ` (VD: "cho tôi 2 ${available[0].name}")` : "";
        return reply(`Dạ anh/chị gõ "xem menu", tên món và số lượng${example}, "xem giỏ hàng" hoặc "đặt hàng" giúp em nha.`);
      }
    }
  }

  // This customer's active cart for this merchant (created on first use).
  _cart(customerId) {
    return this.cartService.getOrCreateCart(customerId, this._merchantId);
  }

  _menuText(available) {
    if (available.length === 0) return "Dạ quán hiện chưa có món nào đang bán.";
    return `Menu hiện có:\n${available.map((p) => `🍜 ${p.name}: ${money(p.price)}`).join("\n")}`;
  }

  _cartText(cart) {
    if (cart.isEmpty) return "Giỏ hàng đang trống.";
    const lines = cart.items.map((i) => `${i.product_name} × ${i.quantity} = ${money(i.subtotal)}`);
    return `${lines.join("\n")}\n\nTạm tính: ${money(cart.total)}`;
  }

  // No merchant push channel exists yet (merchantDispatch.js), so the order
  // is recorded and waits for the merchant; never claim the merchant has it.
  _orderText(order) {
    const merchant = this.merchantDataService.getById(this._merchantId);
    const lines = order.items.map((i) => `${i.product_name} × ${i.quantity} — ${money(i.line_total ?? i.unit_price * i.quantity)}`);
    return [`Đã ghi nhận đơn #${order.order_code} tại ${merchant.name}:`, ...lines, `Tổng: ${money(order.total)}`, "Đơn đang chờ quán xác nhận."].join("\n");
  }

  isOpenNow() {
    return { known: false };
  }
}
