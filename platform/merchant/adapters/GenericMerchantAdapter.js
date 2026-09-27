import { MerchantModule } from "../MerchantModule.js";
import { stripAccents } from "../../../src/nlp/normalize.js";
import { ConversationalOrderingEngine } from "../../conversation/orderingEngine.js";
import { normalizePhrase } from "../../services/productLanguageService.js";
import { matchByName } from "../../nlp/genericOrderText.js";

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
 * Conversation (menu questions, cart, checkout, confirmation) is handled by
 * the platform's ConversationalOrderingEngine on top of CartService /
 * OrderService; this adapter only binds it to one merchant.
 */
export class GenericMerchantAdapter extends MerchantModule {
  // cartService/orderService/conversationStates/cartCheckout are optional:
  // without them the adapter keeps the original menu-only behavior.
  constructor({
    merchantId,
    menuService,
    merchantDataService,
    cartService = null,
    orderService = null,
    conversationStates = null,
    cartCheckout = null,
    productLanguage = null,
    customerMemory = null,
  }) {
    super();
    this._merchantId = merchantId;
    this.menuService = menuService;
    this.merchantDataService = merchantDataService;
    this.productLanguage = productLanguage;
    this.engine =
      cartService && orderService && conversationStates && cartCheckout
        ? new ConversationalOrderingEngine({
            merchantId,
            menuService,
            merchantDataService,
            cartService,
            orderService,
            conversationStates,
            cartCheckout,
            productLanguage,
            customerMemory,
          })
        : null;
  }

  get merchantId() {
    return this._merchantId;
  }

  // The platform can hand this merchant structured, multi-item messages:
  // its conversation runs on the generic engine, not a legacy module.
  get supportsConversationalOrdering() {
    return this.engine !== null;
  }

  async searchProducts(queryText) {
    // A DRAFT/ARCHIVED menu never surfaces in discovery/search — this is
    // the only place that check lives; DiscoveryEngine itself is
    // unchanged and simply sees "no matches" for such a merchant.
    if (!this.menuService.isMenuVisible(this._merchantId)) return [];

    const query = stripAccents(queryText || "");
    const products = this.menuService.listProducts(this._merchantId, { includeUnavailable: true });
    // Every query word in the name, in any order and with words between
    // ("hủ tiếu hải sản" -> "Hủ Tiếu Xào Hải Sản") — the same word rule the
    // merchant's own chat uses; same tier as a substring match.
    const byWords = query.length >= 3 ? new Set(matchByName(queryText, products).candidates.map((p) => p.id)) : new Set();

    const matches = products
      .map((p) => {
        const nameNorm = stripAccents(p.name);
        const keywordNorms = p.keywords.map(stripAccents);
        let matchQuality = null;
        if (nameNorm === query || keywordNorms.includes(query)) matchQuality = "exact";
        else if (keywordNorms.some((k) => query.includes(k))) matchQuality = "keyword";
        else if (query.length >= 3 && (nameNorm.includes(query) || byWords.has(p.id))) matchQuality = "category";
        return matchQuality ? { productId: p.id, name: p.name, price: p.price, available: p.available, matchQuality } : null;
      })
      .filter(Boolean);

    // Language this merchant's own customers have established (TRUSTED
    // only) also finds its product in discovery: "pizza tôm" -> Seafood Pizza.
    const phrase = this.productLanguage ? normalizePhrase(queryText) : null;
    if (phrase) {
      const learned = this.productLanguage.resolveLearned(this._merchantId, phrase, products.filter((p) => p.available), { trustedOnly: true });
      if (learned && !matches.some((m) => m.productId === learned.product.id)) {
        const p = learned.product;
        matches.push({ productId: p.id, name: p.name, price: p.price, available: p.available, matchQuality: "keyword" });
      }
    }
    return matches;
  }

  async getMenuSummary() {
    const merchant = this.merchantDataService.getById(this._merchantId);
    const products = this.menuService.listProducts(this._merchantId, { includeUnavailable: false });
    // categories that have products, in menu order (empty when the menu has none)
    const categories = this.menuService
      .listCategories(this._merchantId)
      .map((c) => ({ name: c.name, count: products.filter((p) => p.category_id === c.id).length }))
      .filter((c) => c.count > 0);
    return {
      name: merchant.name,
      address: merchant.address,
      items: products.map((p) => ({ name: p.name, price: p.price, available: p.available })),
      categories,
    };
  }

  async handleMessage(platformCustomerId, text) {
    if (!this.engine) {
      return {
        replyText:
          "Dạ quán này hiện chỉ hỗ trợ xem menu qua Tổng Đài, chưa đặt món trực tiếp được — anh/chị vui lòng gọi trực tiếp cho quán nha.",
        merchantIntent: null,
        orderRef: null,
      };
    }
    return this.engine.handle(platformCustomerId, text);
  }

  isOpenNow() {
    return { known: false };
  }
}
