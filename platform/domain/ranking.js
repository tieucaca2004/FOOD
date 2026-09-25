import { MERCHANT_STATUS } from "./merchantStatus.js";

// Deterministic ranking — no LLM involved. Scores are just arithmetic over
// signals already computed by the search step; the AI layer never sees or
// influences this. Organic and sponsored results are always kept as two
// separate lists — a sponsored merchant is never presented as organic.
const STATUS_WEIGHT = {
  [MERCHANT_STATUS.ACTIVE]: 1,
  [MERCHANT_STATUS.TRIAL]: 0.8,
};

// A query that names the merchant itself outranks any product-only match
// (max product-only score is 3 + 1 + 1 = 5).
const MERCHANT_NAME_MATCH_BONUS = 10;

function scoreCandidate(candidate) {
  const { matchQuality, hasAvailableMatch, merchantStatus, merchantNameMatch } = candidate;
  let score = merchantNameMatch ? MERCHANT_NAME_MATCH_BONUS : 0;
  score += matchQuality === "exact" ? 3 : matchQuality === "keyword" ? 2 : 1;
  score += hasAvailableMatch ? 1 : 0;
  score += STATUS_WEIGHT[merchantStatus] ?? 0;
  return score;
}

/**
 * @param {Array<{merchant, matches, matchQuality, hasAvailableMatch}>} candidates
 * @returns {{organic: Array, sponsored: Array}}
 */
export function rankMerchantResults(candidates) {
  const scored = candidates.map((c) => ({ ...c, score: scoreCandidate(c) }));
  const organic = scored.filter((c) => !c.merchant.sponsored).sort((a, b) => b.score - a.score);
  const sponsored = scored.filter((c) => c.merchant.sponsored).sort((a, b) => b.score - a.score);
  return { organic, sponsored };
}
