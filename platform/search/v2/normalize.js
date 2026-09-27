// SEARCH INTELLIGENCE V2 — step 1: input normalization (pure).
// The ORIGINAL query is always kept. The folded (accent-free) form is a matching key only — never an identity:
// "tràng" and "Trang" fold to the same letters but are different words.

const MARKS = /[̀-ͯ]/g;

/** NFC, lowercase, "đ" kept. */
export const lowerNfc = (text) => String(text ?? "").normalize("NFC").toLowerCase();

/** Accent-free lowercase ("Bún Cá" -> "bun ca"); "đ" -> "d". */
export const foldText = (text) => lowerNfc(text).normalize("NFD").replace(MARKS, "").replace(/đ/g, "d");

export const hasAccents = (word) => foldText(word) !== lowerNfc(word);

// The tone mark may sit on either vowel ("hoà" = "hòa"); compare vowels + marks without their position.
export function toneSig(word) {
  const nfd = lowerNfc(word).normalize("NFD");
  const marks = [...nfd].filter((c) => /[̀-ͯ]/.test(c)).sort().join("");
  return `${foldText(word)}|${marks}`;
}

/**
 * @returns {{originalQuery: string, normalizedQuery: string, foldedQuery: string,
 *            tokens: {i: number, original: string, lower: string, folded: string, accented: boolean, start: number, end: number}[]}}
 *   start/end: character offsets in normalizedQuery
 */
export function normalizeInput(text) {
  const originalQuery = String(text ?? "");
  const normalizedQuery = originalQuery
    .normalize("NFC")
    .replace(/[“”«»]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[–—]/g, "-")
    .replace(/([!?.,])\1+/g, "$1") // "??" -> "?"
    .replace(/\s+/g, " ")
    .trim();
  const tokens = [...normalizedQuery.matchAll(/[\p{L}\p{N}]+/gu)].map((m, i) => {
    const lower = lowerNfc(m[0]);
    return { i, original: m[0], lower, folded: foldText(lower), accented: hasAccents(lower), start: m.index, end: m.index + m[0].length };
  });
  return { originalQuery, normalizedQuery, foldedQuery: tokens.map((t) => t.folded).join(" "), tokens };
}
