// Confidence of a published claim — computed by the knowledge store from
// its evidence, NEVER accepted from a proposal (a collector or model cannot
// declare itself confident). Deterministic:
//   tier of the source type (taxonomy.source_types)
//   + extraction adjustment (explicit/curated 0, LLM proposal −0.05, rule −0.15)
//   + corroboration bonus per additional INDEPENDENT domain agreeing
//   − conflict penalty when published evidence disagrees
// clamped to [min, max]. Answers use it as a band (high/medium/low), never as a precise number.

export const CONFLICT_PENALTY = 0.2;

export function computeConfidence(taxonomy, { sourceType, extraction, independentDomains = 1, conflict = false }) {
  const cfg = taxonomy.json.confidence;
  const tier = taxonomy.sourceType(sourceType)?.tier ?? taxonomy.sourceType("other").tier;
  const adjust = taxonomy.json.extraction_adjustments[extraction] ?? 0;
  const corroboration = cfg.corroboration_bonus * Math.max(0, independentDomains - 1);
  const raw = tier + adjust + corroboration - (conflict ? CONFLICT_PENALTY : 0);
  return Math.round(Math.min(cfg.max, Math.max(cfg.min, raw)) * 100) / 100;
}

export function confidenceBand(value) {
  if (value === null || value === undefined) return "unknown";
  if (value >= 0.75) return "high";
  if (value >= 0.55) return "medium";
  return "low";
}
