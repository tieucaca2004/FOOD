import { MerchantModule } from "../MerchantModule.js";
import { stripAccents } from "../../../src/nlp/normalize.js"; // generic pure utility — read-only reuse

/**
 * Wraps the existing, unmodified A Tiểu engine (src/services, src/router)
 * behind the platform's MerchantModule contract. Every call here delegates
 * to A Tiểu's real services — nothing about A Tiểu's own code changes.
 *
 * Identity mapping: customers only ever talk to the Tổng Đài OA now, so
 * there is no real "A Tiểu OA zalo_user_id" for them. A Tiểu's schema only
 * needs zalo_user_id to be a stable, unique opaque string per customer —
 * so this adapter synthesizes one as `platform:<platformCustomerId>`. A
 * Tiểu's module has no idea it's being driven by a proxy; its own contract
 * (customers.zalo_user_id unique) is fully satisfied.
 */
export class AtieuMerchantAdapter extends MerchantModule {
  constructor({ merchantId, services, router }) {
    super();
    this._merchantId = merchantId;
    this.services = services; // A Tiểu's src/services/index.js createServices(...) output
    this.router = router; // A Tiểu's src/router/businessRouter.js BusinessRouter instance
  }

  get merchantId() {
    return this._merchantId;
  }

  async searchProducts(queryText) {
    const query = stripAccents(queryText || "");
    const products = this.services.menu.repos.products.list({ includeUnavailable: true });

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
    const products = this.services.menu.listMenu();
    const name = this.services.orders.repos.settings.get("store_name") || "Hủ Tiếu Xào A Tiểu";
    const address = this.services.orders.repos.settings.get("store_address") || null;
    return {
      name,
      address,
      items: products.map((p) => ({ name: p.name, price: p.price, available: p.available })),
    };
  }

  async handleMessage(platformCustomerId, text) {
    const zaloUserId = `platform:${platformCustomerId}`;
    const customer = this.services.customers.getOrCreateByZaloUserId(zaloUserId, null);
    const session = this.services.sessions.getOrCreate(customer.id);
    const { replyText, session: updatedSession } = await this.router.handle({ customer, session, text });
    // current_intent is a field A Tiểu's own router already sets on every
    // turn (src/router/businessRouter.js _reply()) — reading it here is
    // observation, not a modification to A Tiểu's code, and lets the
    // platform log funnel analytics (ADD_TO_CART/CHECKOUT_STARTED/...)
    // without A Tiểu needing to know the platform exists.
    return { replyText, merchantIntent: updatedSession.current_intent, orderRef: this._latestOrderCode(customer.id) };
  }

  _latestOrderCode(atieuCustomerId) {
    const [latest] = this.services.orders.repos.orders.listByCustomer(atieuCustomerId, 1);
    return latest?.order_code || null;
  }

  isOpenNow() {
    // opening_hours is an unverified placeholder string (see
    // data/seed/NEEDS_OWNER_INPUT.md) — never infer open/closed from it.
    return { known: false };
  }
}
