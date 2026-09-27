import { collapseWhitespace, normalizeName, jsonPointer, jsonQuote } from "./text.js";

// Evidence validator for knowledge proposals. Pure: every input is passed
// in (taxonomy, vocabulary, the source row, its raw text, the entity's
// names…), so the rules are testable without a database.
//
// Outcome per proposal:
//   rejected  — a hard failure: invalid against the taxonomy, out of scope
//               (traditional-medicine "tính nóng/mát"), no evidence, raw
//               source missing/changed, quote not verbatim in the raw source,
//               source URL mismatch. Never publishable, not even by review.
//   review    — evidence is real but does not clearly support the claim
//               (term absent, negated, ambiguous, different level, entity not
//               mentioned, rule-derived, conflicting with published data…).
//               The founder decides these cases.
//   published — verified evidence that supports the claim. No manual step.

export const OUTCOME = Object.freeze({ PUBLISHED: "published", REVIEW: "review", REJECTED: "rejected" });

const MIN_QUOTE_WORDS = 2;
const ENTITY_WINDOW_CHARS = 300;

function reason(code, message) {
  return { code, message };
}

/**
 * Checks shared by every proposal: evidence present, raw source intact,
 * quote verbatim in it. Returns hard failures and the quote's position.
 * @param {object} p
 * @param {object} p.evidence {quote, extraction, sourceUrl?}
 * @param {object|null} p.source kb_sources row
 * @param {{text: string|null, hashMatches: boolean, missing: boolean}} p.raw
 */
export function checkEvidence({ evidence, source, raw }) {
  const hard = [];
  const soft = [];
  if (!evidence || !String(evidence.quote ?? "").trim()) return { hard: [reason("MISSING_EVIDENCE", "a quote from a source is required")], soft, at: -1 };
  if (!source) return { hard: [reason("UNKNOWN_SOURCE", "evidence must point at a registered source")], soft, at: -1 };
  if (evidence.extraction === "llm_proposal" && !evidence.sourceUrl) hard.push(reason("MISSING_SOURCE_URL", "an LLM proposal must carry its source URL"));
  if (evidence.sourceUrl && evidence.sourceUrl !== source.url) hard.push(reason("SOURCE_URL_MISMATCH", `proposal URL ${evidence.sourceUrl} is not the source's ${source.url}`));
  if (raw.missing) hard.push(reason("RAW_MISSING", "the raw copy of the source is missing"));
  else if (!raw.hashMatches) hard.push(reason("RAW_CHANGED", "the raw copy no longer matches its recorded hash"));
  if (hard.length) return { hard, soft, at: -1 };

  // Structured sources: the locator is a JSON pointer and the quote must be
  // exactly the value found there — stricter than a substring search.
  if (raw.json !== undefined && String(evidence.locator ?? "").startsWith("/")) {
    const value = jsonPointer(raw.json, evidence.locator);
    if (value === undefined) return { hard: [reason("QUOTE_NOT_FOUND", `nothing at ${evidence.locator} in the source`)], soft, at: -1 };
    if (collapseWhitespace(jsonQuote(value)) !== collapseWhitespace(evidence.quote)) {
      return { hard: [reason("QUOTE_NOT_FOUND", `the quote is not the value at ${evidence.locator}`)], soft, at: -1 };
    }
    if (evidence.extraction === "rule") soft.push(reason("DERIVED_BY_RULE", "rule-derived values are only proposals until reviewed"));
    return { hard, soft, at: -1, pointer: true };
  }
  if (raw.text === null) return { hard, soft: [reason("UNSUPPORTED_RAW_TYPE", `cannot read ${source.content_type} to verify the quote`)], at: -1 };

  const quote = collapseWhitespace(evidence.quote);
  const at = raw.text.indexOf(quote);
  if (at < 0) return { hard: [reason("QUOTE_NOT_FOUND", "the quote does not appear verbatim in the source")], soft, at };
  if (quote.split(" ").length < MIN_QUOTE_WORDS) soft.push(reason("QUOTE_TOO_SHORT", "a one-word quote is too weak on its own"));
  if (evidence.extraction === "rule") soft.push(reason("DERIVED_BY_RULE", "rule-derived values are only proposals until reviewed"));
  return { hard, soft, at };
}

/** Does the quote (or the text right around it) name the entity? */
export function mentionsEntity({ quote, rawText, at, names }) {
  const keys = names.map(normalizeName).filter(Boolean);
  const contains = (text) => {
    const hay = ` ${normalizeName(text)} `;
    return keys.some((k) => hay.includes(` ${k} `));
  };
  if (contains(quote)) return true;
  if (rawText && at >= 0) {
    const around = rawText.slice(Math.max(0, at - ENTITY_WINDOW_CHARS), at + collapseWhitespace(quote).length + ENTITY_WINDOW_CHARS);
    return contains(around);
  }
  return false;
}

/** Structural validity against the taxonomy (hard failures). */
export function checkStructure(taxonomy, claim, { regionExists = () => false, relatedEntityExists = () => false } = {}) {
  const hard = [];
  const add = (code, message) => hard.push(reason(code, message));
  if (taxonomy.isExcludedConcept(claim.key) || taxonomy.isExcludedConcept(claim.value)) {
    add("OUT_OF_SCOPE", `"${claim.key}" is outside Food Intelligence V1`);
    return hard;
  }
  if (!taxonomy.scopes.has(claim.scope)) add("INVALID_SCOPE", `unknown scope "${claim.scope}"`);
  if (claim.scope === "region" && !claim.regionId) add("REGION_REQUIRED", "a region-scoped claim needs a region");
  if (claim.regionId && !regionExists(claim.regionId)) add("UNKNOWN_REGION", `unknown region "${claim.regionId}"`);

  switch (claim.kind) {
    case "facet":
      if (!taxonomy.hasFacetNode(claim.key, claim.value)) add("INVALID_VALUE", `unknown facet node ${claim.key}/${claim.value}`);
      break;
    case "attribute":
      if (!taxonomy.attribute(claim.key)) add("INVALID_VALUE", `unknown attribute "${claim.key}"`);
      else if (!taxonomy.isValidAttributeValue(claim.key, { value: claim.value ?? null, level: claim.level ?? null })) {
        add("INVALID_VALUE", `invalid value/level for ${claim.key}`);
      }
      break;
    case "ingredient":
      if (!taxonomy.hasIngredient(claim.key)) add("INVALID_VALUE", `unknown ingredient "${claim.key}"`);
      if (!taxonomy.json.ingredient_roles.includes(claim.value)) add("INVALID_VALUE", `unknown ingredient role "${claim.value}"`);
      if (claim.necessity && !taxonomy.json.ingredient_necessity.includes(claim.necessity)) add("INVALID_VALUE", `unknown necessity "${claim.necessity}"`);
      break;
    case "ingredient_completeness":
      if (!taxonomy.json.ingredient_completeness.includes(claim.value)) add("INVALID_VALUE", `unknown completeness "${claim.value}"`);
      break;
    case "relation": {
      const rel = taxonomy.relation(claim.key);
      if (!rel) add("INVALID_VALUE", `unknown relation "${claim.key}"`);
      else if (rel.target === "entity" && !relatedEntityExists(claim.value)) add("INVALID_VALUE", `unknown related entity "${claim.value}"`);
      else if (rel.target === "region" && !regionExists(claim.value)) add("INVALID_VALUE", `unknown region "${claim.value}"`);
      break;
    }
    case "description":
      if (!String(claim.value ?? "").trim()) add("INVALID_VALUE", "empty description");
      break;
    default:
      add("INVALID_KIND", `unknown claim kind "${claim.kind}"`);
  }
  return hard;
}

/**
 * Does the quote SUPPORT the claim? Soft failures only (-> review).
 * @param {object} ctx {taxonomy, vocabulary, relatedNames: string[], regionName: string|null, regionNames?: string[]}
 */
export function checkSupport(claim, quote, { taxonomy, vocabulary, relatedNames = [], regionName = null, regionNames = null }) {
  const soft = [];
  const add = (code, message) => soft.push(reason(code, message));
  const { matches, protected: protectedNames, outOfScope } = vocabulary.match(quote);
  const unsupported = (what) => {
    if (outOfScope.length) return reason("OUT_OF_SCOPE_ONLY", `the quote only speaks of "${outOfScope.map((o) => o.text).join(", ")}" (outside V1)`);
    if (protectedNames.length) return reason("PROTECTED_NAME_ONLY", `"${protectedNames.map((p) => p.text).join(", ")}" is a dish name, not evidence of ${what}`);
    return reason("NOT_SUPPORTED_BY_QUOTE", `the quote does not mention ${what}`);
  };

  switch (claim.kind) {
    case "attribute": {
      const attr = taxonomy.attribute(claim.key);
      const relevant = matches.filter((m) => m.concept === claim.key);
      const clear = relevant.filter((m) => !m.ambiguous);
      if (relevant.length === 0) {
        soft.push(unsupported(claim.key));
        break;
      }
      if (clear.length === 0) {
        add("AMBIGUOUS_TERM", `"${relevant.map((m) => m.text).join(", ")}" is ambiguous here`);
        break;
      }
      if (attr.type === "enum") {
        const hit = clear.find((m) => !m.negated && m.value === claim.value);
        if (!hit) add(clear.some((m) => m.negated) ? "NEGATED_IN_QUOTE" : "VALUE_MISMATCH", `the quote does not say ${claim.key} = ${claim.value}`);
        break;
      }
      if (claim.level === "varies") {
        add("NEEDS_FOUNDER_RULE", `"varies" is decided on review, not from one quote`);
        break;
      }
      if (claim.level === "none") {
        if (!clear.some((m) => m.negated)) add("NOT_SUPPORTED_BY_QUOTE", `the quote does not say "không ${attr.label_vi}"`);
        break;
      }
      const positive = clear.filter((m) => !m.negated);
      if (positive.length === 0) add("NEGATED_IN_QUOTE", `the quote negates ${claim.key}`);
      else if (!positive.some((m) => (m.level ?? "medium") === claim.level)) {
        add("LEVEL_MISMATCH", `the quote says ${positive.map((m) => m.level ?? "medium").join("/")}, not ${claim.level}`);
      }
      break;
    }
    case "facet": {
      const accepted = new Set(taxonomy.facetDescendants(claim.key, claim.value));
      const relevant = matches.filter((m) => m.concept === `facet:${claim.key}` && accepted.has(m.value));
      if (relevant.length === 0) soft.push(unsupported(`${claim.key} = ${claim.value}`));
      else if (!relevant.some((m) => !m.ambiguous)) add("AMBIGUOUS_TERM", `"${relevant.map((m) => m.text).join(", ")}" is ambiguous here`);
      else if (!relevant.some((m) => !m.ambiguous && !m.negated)) add("NEGATED_IN_QUOTE", `the quote negates ${claim.value}`);
      break;
    }
    case "ingredient": {
      const relevant = matches.filter((m) => m.concept === "ingredient" && taxonomy.ingredientIsA(m.value, claim.key));
      if (relevant.length === 0) soft.push(unsupported(`ingredient ${claim.key}`));
      else if (!relevant.some((m) => !m.ambiguous)) add("AMBIGUOUS_TERM", `"${relevant.map((m) => m.text).join(", ")}" is ambiguous here`);
      else if (!relevant.some((m) => !m.ambiguous && !m.negated)) add("NEGATED_IN_QUOTE", `the quote says the dish has no ${claim.key}`);
      break;
    }
    case "ingredient_completeness":
      add("NEEDS_FOUNDER_RULE", "whether an ingredient list is complete is decided on review");
      break;
    case "relation": {
      // a region-target relation (specialty, style, origin) must name the region, in any of its written forms
      const names = taxonomy.relation(claim.key)?.target === "region" ? (regionNames ?? [regionName]).filter(Boolean) : relatedNames;
      const hay = ` ${normalizeName(quote)} `;
      if (!names.some((n) => hay.includes(` ${normalizeName(n)} `))) add("NOT_SUPPORTED_BY_QUOTE", `the quote does not name ${claim.value}`);
      break;
    }
    case "description":
      if (!collapseWhitespace(quote).includes(collapseWhitespace(claim.value))) {
        add("DESCRIPTION_NOT_VERBATIM", "a description must be the source's own words (no paraphrase)");
      }
      break;
    default:
      break;
  }
  return soft;
}

/** Does the quote contain this name (accent-insensitive, whole words)? */
export function quoteNamesIt(quote, name) {
  const key = normalizeName(name);
  return Boolean(key) && ` ${normalizeName(quote)} `.includes(` ${key} `);
}

export function decide(hard, soft) {
  if (hard.length) return OUTCOME.REJECTED;
  if (soft.length) return OUTCOME.REVIEW;
  return OUTCOME.PUBLISHED;
}
