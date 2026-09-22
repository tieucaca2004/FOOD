import { rankMerchantResults } from "../domain/ranking.js";

/**
 * USER QUERY -> (NLP already done by caller) -> structured keywords ->
 * SEARCH DATABASE (this class) -> RANK RESULTS -> caller formats AI RESPONSE.
 * No LLM call happens inside this class — see spec §7.
 *
 * Phase 2 cutover: merchant-record lookups go through MerchantDataService
 * (the account_status/active split model from Phase 1) instead of hitting
 * MerchantRepository directly. This changes only WHERE the discoverability
 * check reads from, not what it decides — MerchantRepository.setStatus()
 * dual-writes both models, so every merchant already in the DB agrees
 * under either path. Ranking behavior, matching, and the
 * organic/sponsored split are all untouched (see domain/ranking.js, not
 * modified in this phase).
 */
export class DiscoveryEngine {
  constructor(merchantDataService, registry) {
    this.merchantDataService = merchantDataService;
    this.registry = registry;
  }

  /**
   * @returns {{organic: Array<{merchant, matches}>, sponsored: Array}}
   */
  async searchByKeywords(keywords) {
    const discoverable = this.merchantDataService.listDiscoverable();
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
    return this.merchantDataService.findDiscoverableByNameFragment(nameFragment);
  }

  // Any-status lookup — used by PlatformRouter to tell "no such merchant"
  // apart from "merchant exists but isn't currently discoverable" so it
  // can reply "quán này hiện không khả dụng" instead of "không tìm thấy".
  searchByMerchantNameAnyStatus(nameFragment) {
    return this.merchantDataService.findAnyStatusByNameFragment(nameFragment);
  }
}
