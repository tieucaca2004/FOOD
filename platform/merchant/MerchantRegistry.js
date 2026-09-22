import { AtieuMerchantAdapter } from "./adapters/AtieuMerchantAdapter.js";
import { GenericMerchantAdapter } from "./adapters/GenericMerchantAdapter.js";

/**
 * Resolves merchants.module -> concrete adapter. Adding merchant B (per
 * spec §31) that uses an existing module ('generic') needs zero changes
 * here — only a new row in `merchants` + its catalog. A brand-new *kind*
 * of module (a second custom code engine) would register its factory here,
 * same shape as 'atieu' — Platform Router / Discovery / Order Engine never
 * need to change.
 */
export class MerchantRegistry {
  constructor({ repos, moduleFactories }) {
    this.repos = repos;
    this.moduleFactories = moduleFactories; // { atieu: () => AtieuMerchantAdapter, generic: () => GenericMerchantAdapter }
    this._cache = new Map();
  }

  getAdapter(merchantId) {
    if (this._cache.has(merchantId)) return this._cache.get(merchantId);

    const merchant = this.repos.merchants.getById(merchantId);
    if (!merchant) return null;

    const factory = this.moduleFactories[merchant.module];
    if (!factory) throw new Error(`No adapter factory registered for module "${merchant.module}"`);

    const adapter = factory(merchant);
    this._cache.set(merchantId, adapter);
    return adapter;
  }

  invalidate(merchantId) {
    this._cache.delete(merchantId);
  }
}

// Convenience factory builders — kept here so platform/server.js and tests
// share the exact same wiring logic.
export function buildAtieuAdapterFactory({ services, router }) {
  return (merchant) => new AtieuMerchantAdapter({ merchantId: merchant.merchant_id, services, router });
}

export function buildGenericAdapterFactory({ repos }) {
  return (merchant) => new GenericMerchantAdapter({ merchantId: merchant.merchant_id, repos });
}
