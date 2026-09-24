import { isAccountDiscoverable } from "../domain/merchantStatus.js";

/**
 * Thin routing layer named to match the architecture doc: given a
 * merchant_id, resolve and delegate to that merchant's module. Kept
 * separate from MerchantRegistry (which owns adapter construction/caching)
 * so PlatformRouter's dependency is "route this merchant_id" rather than
 * "build me an adapter".
 */
export class MerchantRouter {
  constructor(registry, { merchantData }) {
    this.registry = registry;
    this.merchantData = merchantData;
  }

  resolve(merchantId) {
    const merchant = this.merchantData.getById(merchantId);
    if (!merchant) return { merchant: null, adapter: null };
    return { merchant, adapter: this.registry.getAdapter(merchantId) };
  }

  // Phase 2 cutover: reads the split account_status/active model instead of
  // the legacy status string. MerchantRepository.setStatus() dual-writes
  // both, so this is behaviorally identical to the old check for every
  // merchant already in the DB.
  isRoutable(merchant) {
    return Boolean(merchant) && isAccountDiscoverable({ accountStatus: merchant.account_status, active: merchant.active });
  }

  async routeMessage(merchantId, platformCustomerId, text) {
    const { merchant, adapter } = this.resolve(merchantId);
    if (!merchant || !adapter) {
      return { ok: false, reason: "MERCHANT_NOT_FOUND" };
    }
    // A merchant that stopped being routable mid-conversation (expired,
    // suspended, closed) must not keep receiving messages or orders.
    if (!this.isRoutable(merchant)) {
      return { ok: false, reason: "MERCHANT_NOT_ROUTABLE" };
    }
    const { replyText, merchantIntent, orderRef } = await adapter.handleMessage(platformCustomerId, text);
    return { ok: true, replyText, merchantIntent, orderRef };
  }
}
