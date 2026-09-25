import { rankMerchantResults } from "../domain/ranking.js";
import { normalizeSearchQuery, matchesMerchantName } from "../nlp/searchQuery.js";

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
 * under either path.
 *
 * Search matches a merchant two ways, both generic (no per-merchant rule):
 * - by product, through each merchant's own adapter.searchProducts();
 * - by merchant name/slug, accent- and case-insensitively
 *   (searchQuery.matchesMerchantName).
 * A merchant matched by name is flagged `merchantNameMatch` and ranks above
 * product-only matches (domain/ranking.js); organic/sponsored stay separate.
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
    // Idempotent on already-normalized keywords (the concierge path), and
    // makes direct callers (GET /api/platform/search?q=tìm pizza) behave the same.
    const query = normalizeSearchQuery(keywords);
    if (!query.text) return rankMerchantResults([]);

    const discoverable = this.merchantDataService.listDiscoverable();
    const candidates = [];

    for (const merchant of discoverable) {
      const merchantNameMatch = matchesMerchantName(merchant, query.normalized);
      const adapter = this.registry.getAdapter(merchant.merchant_id);
      const matches = adapter ? await adapter.searchProducts(query.text) : [];
      if (matches.length === 0 && !merchantNameMatch) continue;

      const bestQuality =
        matches.length === 0
          ? "merchant_name"
          : matches.some((m) => m.matchQuality === "exact")
          ? "exact"
          : matches.some((m) => m.matchQuality === "keyword")
          ? "keyword"
          : "category";

      candidates.push({
        merchant,
        matches,
        matchQuality: bestQuality,
        merchantNameMatch,
        hasAvailableMatch: matches.some((m) => m.available),
        merchantStatus: merchant.status,
      });
    }

    return rankMerchantResults(candidates);
  }

  // Discoverable merchants whose name contains the fragment (SQL LIKE, as
  // before) plus accent-insensitive name/slug matches ("nom nom" finds
  // "Nôm Nôm") — a superset of the previous result, never fewer.
  searchByMerchantName(nameFragment) {
    return this._withLooseNameMatches(
      this.merchantDataService.findDiscoverableByNameFragment(nameFragment),
      this.merchantDataService.listDiscoverable(),
      nameFragment
    );
  }

  // Any-status lookup — used by PlatformRouter to tell "no such merchant"
  // apart from "merchant exists but isn't currently discoverable" so it
  // can reply "quán này hiện không khả dụng" instead of "không tìm thấy".
  searchByMerchantNameAnyStatus(nameFragment) {
    return this._withLooseNameMatches(
      this.merchantDataService.findAnyStatusByNameFragment(nameFragment),
      this.merchantDataService.listAll(),
      nameFragment
    );
  }

  _withLooseNameMatches(exactMatches, pool, nameFragment) {
    const { normalized } = normalizeSearchQuery(nameFragment);
    const seen = new Set(exactMatches.map((m) => m.merchant_id));
    const extra = pool.filter((m) => !seen.has(m.merchant_id) && matchesMerchantName(m, normalized));
    return [...exactMatches, ...extra];
  }
}
