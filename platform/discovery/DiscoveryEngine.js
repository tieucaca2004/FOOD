import { rankMerchantResults } from "../domain/ranking.js";
import { isDiscoverable } from "../domain/merchantStatus.js";

/**
 * USER QUERY -> (NLP already done by caller) -> structured keywords ->
 * SEARCH DATABASE (this class) -> RANK RESULTS -> caller formats AI RESPONSE.
 * No LLM call happens inside this class — see spec §7.
 */
export class DiscoveryEngine {
  constructor(repos, registry) {
    this.repos = repos;
    this.registry = registry;
  }

  /**
   * @returns {{organic: Array<{merchant, matches}>, sponsored: Array}}
   */
  async searchByKeywords(keywords) {
    const discoverable = this.repos.merchants.listDiscoverable();
    const candidates = [];

    for (const merchant of discoverable) {
      const adapter = this.registry.getAdapter(merchant.merchant_id);
      if (!adapter) continue;
      const matches = await adapter.searchProducts(keywords);
      if (matches.length === 0) continue;

      const bestQuality = matches.some((m) => m.matchQuality === "exact")
        ? "exact"
        : matches.some((m) => m.matchQuality === "keyword")
        ? "keyword"
        : "category";

      candidates.push({
        merchant,
        matches,
        matchQuality: bestQuality,
        hasAvailableMatch: matches.some((m) => m.available),
        merchantStatus: merchant.status,
      });
    }

    return rankMerchantResults(candidates);
  }

  searchByMerchantName(nameFragment) {
    return this.repos.merchants.findByNameFragment(nameFragment).filter((m) => isDiscoverable(m.status));
  }
}
