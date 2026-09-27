import { stripAccents } from "../../src/nlp/normalize.js";

// Typo-tolerant product matching ("piza hai san", "coka"). Used only to
// SUGGEST a product ("ý anh/chị là …?"), never to act on one directly.

function words(text) {
  return stripAccents(String(text ?? "").normalize("NFC"))
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

export function levenshtein(a, b) {
  if (a === b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = up;
    }
  }
  return prev[b.length];
}

function wordMatches(typed, nameWord) {
  if (typed === nameWord) return true;
  if (typed.length >= 4 && nameWord.startsWith(typed)) return true;
  if (typed.length < 4 || nameWord.length < 3) return false;
  return levenshtein(typed, nameWord) <= (typed.length >= 7 ? 2 : 1);
}

/** Products whose name contains every typed word, allowing small typos. */
export function typoCandidates(phrase, products) {
  const typed = words(phrase);
  if (typed.length === 0) return [];
  return products.filter((p) => {
    const nameWords = words(p.name);
    return typed.every((t) => nameWords.some((n) => wordMatches(t, n)));
  });
}

/** Words the phrase shares with a product name (3+ letters), for context hints. */
export function sharedWords(phrase, productName) {
  const name = new Set(words(productName));
  return words(phrase).filter((w) => w.length >= 3 && name.has(w));
}
