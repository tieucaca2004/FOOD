import { MerchantModule } from "../MerchantModule.js";
import { stripAccents } from "../../../src/nlp/normalize.js";

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
  constructor({ merchantId, menuService, merchantDataService }) {
    super();
    this._merchantId = merchantId;
    this.menuService = menuService;
    this.merchantDataService = merchantDataService;
  }

  get merchantId() {
    return this._merchantId;
  }

  async searchProducts(queryText) {
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

  // V1: generic merchants don't have their own conversational cart/order
  // engine yet — the platform can show their menu via Discovery, but a
  // real chat-driven cart for them is a follow-up (see final report).
  async handleMessage(_platformCustomerId, _text) {
    return {
      replyText: "Dạ quán này hiện chỉ hỗ trợ xem menu qua Tổng Đài, chưa đặt món trực tiếp được — anh/chị vui lòng gọi trực tiếp cho quán nha.",
      merchantIntent: null,
      orderRef: null,
    };
  }

  isOpenNow() {
    return { known: false };
  }
}
