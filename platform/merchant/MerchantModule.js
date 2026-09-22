/**
 * Contract every merchant implementation (adapter) must satisfy so the
 * Platform Router / Discovery Engine can treat every merchant uniformly,
 * whether it's backed by a dedicated code module (A Tiểu) or a purely
 * data-driven "generic" merchant.
 *
 * Implementations never expose their internal DB/schema to the platform —
 * everything crosses this boundary as plain data.
 */
export class MerchantModule {
  /** @returns {string} */
  get merchantId() {
    throw new Error("not implemented");
  }

  /**
   * Free-text product search scoped to this merchant only. Deterministic —
   * no LLM call inside an adapter's searchProducts implementation.
   * @returns {Promise<Array<{productId, name, price, available, matchQuality: 'exact'|'keyword'|'category'}>>}
   */
  async searchProducts(_queryText) {
    throw new Error("not implemented");
  }

  /** @returns {Promise<{name, address, items: Array<{name, price, available}>}>} */
  async getMenuSummary() {
    throw new Error("not implemented");
  }

  /**
   * Routes one turn of conversation into the merchant's own engine, using
   * a platform-namespaced customer identity (see AtieuMerchantAdapter for
   * why this is not a raw Zalo user id).
   * @returns {Promise<{replyText: string, merchantIntent: string|null, orderRef: string|null}>}
   *   `merchantIntent` and `orderRef` are best-effort funnel signals read
   *   from the merchant's own state (never invented) so the platform can
   *   log ADD_TO_CART/CHECKOUT_STARTED/ORDER_CREATED analytics events.
   */
  async handleMessage(_platformCustomerId, _text) {
    throw new Error("not implemented");
  }

  /**
   * @returns {{known: boolean, open?: boolean}} `known: false` when the
   * merchant hasn't provided a structured schedule — callers must not
   * infer open/closed from an unstructured placeholder string.
   */
  isOpenNow() {
    return { known: false };
  }
}
