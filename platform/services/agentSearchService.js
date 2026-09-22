/**
 * Orchestration layer between the AI Concierge and DiscoveryEngine, per
 * the Phase 2 target architecture:
 *
 *   Customer -> AI Concierge -> AgentSearchService -> DiscoveryEngine
 *     -> MerchantDataService -> MerchantRepository/ProductRepository -> DB
 *
 * Never touches a repository or raw DB directly — everything here
 * delegates to DiscoveryEngine (global/name search) or a merchant's own
 * adapter (merchant-scoped product search), both of which already sit on
 * top of MerchantDataService/MerchantRegistry. This class adds no new
 * business rules, no new ranking, no new matching logic — it only gives
 * the concierge layer a single, small, tool-call-shaped surface.
 */
export class AgentSearchService {
  constructor({ discovery, registry }) {
    this.discovery = discovery;
    this.registry = registry;
  }

  /**
   * Top-level entry point: routes to a merchant-scoped or global search
   * depending on whether the caller supplies a merchantId — this is how
   * "session already has merchant_id -> don't re-guess, don't search the
   * whole marketplace" (spec §22) is enforced at the search layer itself,
   * not just left to the caller's discipline.
   */
  async search(query, { merchantId } = {}) {
    if (merchantId) return this.searchWithinMerchant(merchantId, query);
    return this.searchMerchants(query);
  }

  // Global discovery — every discoverable merchant's catalog is searched,
  // then ranked (organic/sponsored kept separate) by DiscoveryEngine.
  async searchMerchants(query) {
    return this.discovery.searchByKeywords(query);
  }

  // Flattened product-level view across every discoverable merchant, or
  // scoped to one merchant when merchantId is supplied. Each row carries
  // its own merchant_id/merchant_name so the caller never has to guess
  // provenance — matches the §19 result contract.
  async searchProducts(query, { merchantId } = {}) {
    if (merchantId) {
      const { matches } = await this.searchWithinMerchant(merchantId, query);
      const merchant = this.registry.repos.merchants.getById(merchantId);
      return matches.map((m) => ({
        merchant_id: merchantId,
        merchant_name: merchant?.name ?? null,
        product_id: m.productId,
        product_name: m.name,
        price: m.price,
        availability: m.available,
      }));
    }

    const { organic, sponsored } = await this.discovery.searchByKeywords(query);
    return [...organic, ...sponsored].flatMap((candidate) =>
      candidate.matches.map((m) => ({
        merchant_id: candidate.merchant.merchant_id,
        merchant_name: candidate.merchant.name,
        product_id: m.productId,
        product_name: m.name,
        price: m.price,
        availability: m.available,
      }))
    );
  }

  // Tenant-isolated: only ever asks the ONE merchant's own adapter — this
  // is the enforcement point for "món bò bao nhiêu?" while
  // session.merchant_id=ATIEU001 never leaking into MERCHANT002/003 data.
  async searchWithinMerchant(merchantId, query) {
    const adapter = this.registry.getAdapter(merchantId);
    if (!adapter) return { merchantId, matches: [] };
    const matches = await adapter.searchProducts(query);
    return { merchantId, matches };
  }
}
