import { nfc, normalizeName, hasDiacritics } from "../text.js";

// Normalization and term hygiene for the term rule engine. Pure functions, no data access.

/** "Bún Cá!" -> "bun ca" (the matching key; the original text is always kept separately). */
export const termKey = (text) => normalizeName(nfc(String(text ?? "")));
export const lowerNfc = (text) => nfc(String(text ?? "")).toLowerCase();
export { hasDiacritics };

// Words that are never a dish name on their own — conversation, quantity, pronouns, questions, generic food words.
// A term made ONLY of these can never be proposed, and they never match alone.
export const GENERIC_WORDS = new Set(
  (
    "mon quan an uong ngon gia tien con dau nay kia do ay day toi minh ban em anh chi co khong ko k gi nao sao the vay nua them cho la va voi " +
    "o tai tren duoi nhung cac mot hai ba bon nam sau bay tam chin muoi so cai to dia ly phan suat hon nhat rat qua lam nhieu it goi dat mua " +
    "xem tim kiem muon can duoc roi luon cung deu chi thi ma nen vi neu hay hoac nhe nha a oi da dang se vua moi"
  ).split(" ")
);

export function onlyGenericWords(key) {
  const words = String(key).split(" ").filter(Boolean);
  return words.length > 0 && words.every((w) => GENERIC_WORDS.has(w));
}

/** Tokenize keeping each token's original (accented) form and its key, for whole-word matching. */
export function tokens(text) {
  return lowerNfc(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map((original) => ({ original, key: termKey(original) }))
    .filter((t) => t.key);
}

/** Levenshtein distance (small strings only). */
export function editDistance(a, b) {
  if (a === b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}
