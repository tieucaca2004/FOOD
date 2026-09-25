import { stripAccents } from "../../src/nlp/normalize.js";

// Shared, deterministic query normalization for marketplace search (used by
// the concierge and DiscoveryEngine). Leading/trailing conversational
// phrases ("tìm", "tìm quán", "cho tôi tìm", "tìm giúp tôi", "nha", …) are
// recognized accent-insensitively — customers often type "tim quan …" — but
// only whole tokens at the very start/end are removed: the words in the
// middle reach product search exactly as the customer typed them.

// Accent-free phrases; at each edge the longest matching phrase wins, and
// stripping repeats until no phrase matches.
const LEADING_PHRASES = [
  "cho toi tim", "cho minh tim", "cho em tim", "giup toi tim", "giup minh tim",
  "tim giup toi", "tim giup minh", "tim giup em", "tim giup", "tim ho toi", "tim ho", "tim kiem",
  "toi muon tim", "minh muon tim", "toi can tim", "minh can tim",
  "toi muon an", "minh muon an", "em muon an", "muon an", "toi muon", "minh muon",
  "cho toi", "cho minh", "cho em",
  "tim", "quan an", "quan", "nha hang",
].map((p) => p.split(" "));

const TRAILING_PHRASES = ["nao ngon", "khong a", "khong", "a", "nhe", "nha", "voi", "di", "duoc khong"].map((p) => p.split(" "));

const EDGE_PUNCTUATION = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu;

/** "Nôm Nôm-Restaurant!" -> "nom nom restaurant" */
export function normalizeForMatch(text) {
  return stripAccents(text || "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function tokenKey(token) {
  return stripAccents(token).replace(/[^a-z0-9]/g, "");
}

function longestPhraseAt(keys, index, phrases, fromEnd) {
  let best = 0;
  for (const phrase of phrases) {
    if (phrase.length <= best || phrase.length > keys.length) continue;
    const start = fromEnd ? keys.length - index - phrase.length : index;
    if (start < 0) continue;
    if (phrase.every((word, i) => keys[start + i] === word)) best = phrase.length;
  }
  return best;
}

/**
 * @returns {{text: string, normalized: string}}
 *   text: the meaningful part, original accents/casing kept (for product search)
 *   normalized: its accent-free, lowercase, punctuation-free form (for name matching)
 */
export function normalizeSearchQuery(raw) {
  const tokens = [...String(raw || "").matchAll(/\S+/g)];
  const keys = tokens.map((m) => tokenKey(m[0]));

  let start = 0;
  let end = tokens.length; // exclusive
  // Strip repeatedly: "cho tôi tìm quán Nôm Nôm" -> "tìm quán…" -> "quán…" -> "Nôm Nôm".
  for (;;) {
    const n = longestPhraseAt(keys.slice(start, end), 0, LEADING_PHRASES, false);
    if (n === 0 || start + n >= end) break; // never strip the whole query away
    start += n;
  }
  for (;;) {
    const n = longestPhraseAt(keys.slice(start, end), 0, TRAILING_PHRASES, true);
    if (n === 0 || end - n <= start) break;
    end -= n;
  }

  if (start >= end) return { text: "", normalized: "" };
  const from = tokens[start].index;
  const to = tokens[end - 1].index + tokens[end - 1][0].length;
  const text = String(raw).slice(from, to).replace(EDGE_PUNCTUATION, "");
  return { text, normalized: normalizeForMatch(text) };
}

/**
 * Does `query` (a normalizeSearchQuery().normalized string) name this
 * merchant? Checked against merchant.name and merchant.slug, accent- and
 * case-insensitively: every query word must be a word of the name/slug, or
 * the query (5+ chars, spaces ignored) must appear inside it ("nomnom").
 */
export function matchesMerchantName(merchant, query) {
  const queryWords = query.split(" ").filter(Boolean);
  const compactQuery = queryWords.join("");
  if (compactQuery.length < 3) return false;
  return [merchant.name, merchant.slug].some((field) => {
    const fieldNorm = normalizeForMatch(field);
    if (!fieldNorm) return false;
    const fieldWords = new Set(fieldNorm.split(" "));
    if (queryWords.every((w) => fieldWords.has(w))) return true;
    return compactQuery.length >= 5 && fieldNorm.replace(/ /g, "").includes(compactQuery);
  });
}
