import { isDiscoverable } from "../domain/merchantStatus.js";

/**
 * Thin routing layer named to match the architecture doc: given a
 * merchant_id, resolve and delegate to that merchant's module. Kept
 * separate from MerchantRegistry (which owns adapter construction/caching)
 * so PlatformRouter's dependency is "route this merchant_id" rather than
 * "build me an adapter".
 */
export class MerchantRouter {
  constructor(registry) {
    this.registry = registry;
  }

  resolve(merchantId) {
    const merchant = this.registry.repos.merchants.getById(merchantId);
    if (!merchant) return { merchant: null, adapter: null };
    return { merchant, adapter: this.registry.getAdapter(merchantId) };
  }

  isRoutable(merchant) {
    return Boolean(merchant) && isDiscoverable(merchant.status);
  }

  async routeMessage(merchantId, platformCustomerId, text) {
    const { merchant, adapter } = this.resolve(merchantId);
    if (!merchant || !adapter) {
      return { ok: false, reason: "MERCHANT_NOT_FOUND" };
    }
    const { replyText, merchantIntent, orderRef } = await adapter.handleMessage(platformCustomerId, text);
    return { ok: true, replyText, merchantIntent, orderRef };
  }
}
