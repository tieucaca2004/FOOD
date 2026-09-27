import { GENERIC_WORDS, termKey, hasDiacritics } from "./termNormalize.js";

// Controlled typo / typing-variant recognition for the term matcher. PRECISION > RECALL.
// Pure functions; no data access, nothing is ever stored (a typo becomes a relation only through
// PROPOSED -> REVIEW -> APPROVED by a person).
//
//   INPUT_METHOD  Telex / VNI typed with the input method off ("bun cas", "bu1n ca1"), decoded WITH its marks and
//                 required to spell the dish exactly ("caa" is "câ", never "cá")
//   ACCENT        right letters, wrong tone / vowel marks the customer DID type ("bún cà", "bún chã cá")
//   DOUBLED       one key pressed twice ("bun cca", "bánh cănn")
//   PHONETIC      common Vietnamese spelling confusions (c/k, tr/ch, s/x, d/gi/r, i/y, iêu/iu, final n/ng)
//   TRANSPOSE     two neighbouring letters swapped ("bahn")
//   EDIT          one letter missing / extra / wrong
// A fuzzy result is only a CANDIDATE: the matcher resolves nothing below its threshold (by default only a clean
// INPUT_METHOD decoding), turns one candidate into a "did you mean" and several into AMBIGUOUS.

export const TYPO_CONFIDENCE = { INPUT_METHOD: 0.95, DOUBLED: 0.85, PHONETIC: 0.85, ACCENT: 0.8, TRANSPOSE: 0.8, EDIT: 0.7 };

const TONES = /[̣̀́̃̉]/g;
const TONE_MARK = { s: "́", f: "̀", r: "̉", x: "̃", j: "̣", 1: "́", 2: "̀", 3: "̉", 4: "̃", 5: "̣" };
const VOWEL = /[aeiouyâăêôơư]/;

/** A syllable's letters (with vowel shape marks) + its tone, wherever the tone mark was placed ("hoà" = "hòa"). */
export function toneSig(word) {
  const d = String(word ?? "").normalize("NFD");
  return `${d.replace(TONES, "").normalize("NFC")}|${(d.match(TONES) ?? []).sort().join("")}`;
}

/** Shaped letters (â ă ê ô ơ ư đ) of a word, tones ignored. */
const shapes = (word) => [...String(word).normalize("NFD").replace(TONES, "").normalize("NFC")].filter((c) => /[âăêôơưđ]/.test(c)).sort();

const withTone = (word, mark) => {
  if (!mark) return word;
  const chars = [...word];
  let at = -1;
  chars.forEach((c, i) => VOWEL.test(c) && (at = i));
  if (at < 0) return null;
  chars.splice(at + 1, 0, mark);
  return chars.join("").normalize("NFC");
};

// ---------------------------------------------------------------- input-method residue (IME off)
/** The Vietnamese word a Telex / VNI spelling stands for (NFC, with marks), or null when it is not one. */
export function decodeTyping(raw) {
  const w = String(raw ?? "").toLowerCase();
  if (!/^[a-z0-9]+$/.test(w) || !/[a-z]/.test(w)) return null;
  if (/\d/.test(w)) {
    // VNI: 1-5 tones, 6 ^ (a e o), 7 horn (o u), 8 breve (a), 9 đ
    if (!/^[a-z][a-z1-9]*$/.test(w)) return null;
    let out = "";
    let tone = null;
    for (const c of w) {
      if (/[1-5]/.test(c)) tone = TONE_MARK[c];
      else if (c === "6") out = out.replace(/([aeo])([^aeo]*)$/, (m, v, rest) => ({ a: "â", e: "ê", o: "ô" })[v] + rest);
      else if (c === "7") out = out.replace(/([ou])([^ou]*)$/, (m, v, rest) => ({ o: "ơ", u: "ư" })[v] + rest);
      else if (c === "8") out = out.replace(/a([^a]*)$/, "ă$1");
      else if (c === "9") out = out.replace(/d/, "đ");
      else out += c;
    }
    const decoded = withTone(out, tone);
    return decoded && decoded !== w ? decoded : null;
  }
  // Telex: aa â, aw ă, ee ê, oo ô, ow ơ, uw ư, dd đ; a final s f r x j is the tone (no Vietnamese word ends with one)
  const shape = (s) => s.replace(/dd/g, "đ").replace(/aa/g, "â").replace(/aw/g, "ă").replace(/ee/g, "ê").replace(/oo/g, "ô").replace(/uw/g, "ư").replace(/ow/g, "ơ").replace(/uơ/g, "ươ").replace(/w/g, "ư");
  let body = shape(w);
  let tone = null;
  if (w.length >= 2 && /[sfrxj]$/.test(w)) {
    const bare = shape(w.slice(0, -1));
    if (/[aeiouyâăêôơư](?:c|ch|m|n|ng|nh|p|t)?$/.test(bare)) {
      body = bare;
      tone = TONE_MARK[w.at(-1)];
    }
  }
  const decoded = withTone(body, tone);
  return decoded && decoded !== w ? decoded : null;
}

// ---------------------------------------------------------------- common spelling confusions
export function phoneticKey(word) {
  return String(word)
    .replace(/^k/, "c")
    .replace(/^q(?=u)/, "c")
    .replace(/^tr/, "ch")
    .replace(/^x/, "s")
    .replace(/^gi/, "d")
    .replace(/^r/, "d")
    .replace(/y/g, "i")
    .replace(/ieu$/, "iu")
    .replace(/ng$/, "n");
}

/** Optimal-string-alignment distance (adjacent swap = 1) and whether the single edit was a swap. */
function osa(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  const distance = d[a.length][b.length];
  const swapped = distance === 1 && a.length === b.length && [...a].filter((c, i) => c !== b[i]).length === 2;
  return { distance, swapped };
}

const isDoubled = (typed, target) => typed.length === target.length + 1 && [...typed].some((c, i) => i > 0 && c === typed[i - 1] && typed.slice(0, i) + typed.slice(i + 1) === target);

/**
 * How a typed word relates to one word of a term, or null when it is not a safe typo of it.
 * @param {{original: string, key: string}} typed
 * @param {string} targetKey accent-free key of the term word
 * @param {string} targetWord the term word as written (lower-case NFC)
 * @returns {{kind: string, edits: number}|null}
 */
export function wordTypo(typed, targetKey, targetWord) {
  if (typed.key === targetKey) return { kind: "SAME", edits: 0 };
  if (/^\d+$/.test(typed.key)) return null; // a number is never a typo of a word
  if (GENERIC_WORDS.has(typed.key)) return null; // a typo that IS an everyday word ("có", "còn") is that word
  if (!hasDiacritics(typed.original)) {
    const decoded = decodeTyping(typed.original);
    if (decoded && termKey(decoded) === targetKey && toneSig(decoded) === toneSig(targetWord)) return { kind: "INPUT_METHOD", edits: 0 };
    // not that word's Telex / VNI spelling: it may still be a plain slip ("chaa" -> "chả" doubled, not "châ")
  } else {
    // marks the customer typed are evidence: "cănn" can be "căn", never "canh"
    const want = shapes(targetWord);
    if (shapes(typed.original).some((c) => !want.includes(c))) return null;
  }
  const t = typed.key;
  if (isDoubled(t, targetKey)) return { kind: "DOUBLED", edits: 1 };
  if (phoneticKey(t) === phoneticKey(targetKey)) return { kind: "PHONETIC", edits: 1 };
  if (targetKey.length <= 2 || t.length <= 2) return null; // a 2-letter word only takes a doubled key or a spelling confusion
  const { distance, swapped } = osa(t, targetKey);
  if (distance !== 1) return null;
  if (!swapped && phoneticKey(t)[0] !== phoneticKey(targetKey)[0]) return null; // "banh" vs "canh": another word, not a typo
  return { kind: swapped ? "TRANSPOSE" : "EDIT", edits: 1 };
}

/**
 * A typed span against a term.
 * @param {{original: string, key: string}[]} span
 * @param {string[]} termKeys  the term's word keys
 * @param {string[]} termWords the term's words as written (lower-case NFC)
 * @returns {{kind: string, edits: number, confidence: number}|null}
 */
export function spanTypo(span, termKeys, termWords) {
  if (span.length !== termKeys.length || termWords.length !== termKeys.length) return null;
  const words = span.map((t, i) => wordTypo(t, termKeys[i], termWords[i]));
  if (words.some((w) => !w)) return null;
  const kinds = words.filter((w) => w.kind !== "SAME").map((w) => w.kind);
  const edits = words.reduce((n, w) => n + w.edits, 0);
  const letters = termKeys.join("").length;
  if (kinds.includes("INPUT_METHOD")) {
    if (kinds.some((k) => k !== "INPUT_METHOD")) return null; // decoded as a whole, never mixed with typos
    if (span.some((t, i) => words[i].kind === "SAME" && hasDiacritics(t.original) && toneSig(t.original) !== toneSig(termWords[i]))) return null;
    return { kind: "INPUT_METHOD", edits: 0, confidence: TYPO_CONFIDENCE.INPUT_METHOD };
  }
  if (!kinds.length) {
    // same letters: only marks the customer typed differ; a one-word name never takes an accent guess ("giỏ" is not "Giò")
    const wrongMarks = span.some((t, i) => hasDiacritics(t.original) && toneSig(t.original) !== toneSig(termWords[i]));
    return wrongMarks && span.length >= 2 ? { kind: "ACCENT", edits: 0, confidence: TYPO_CONFIDENCE.ACCENT } : null;
  }
  if (edits > (letters >= 10 ? 2 : 1)) return null; // two slips only in a long name
  if (span.length === 1) {
    if (letters < 6) return null; // a short single word is never guessed
  } else {
    // anchored: one word typed exactly right, and it is a real food word — or the name is long enough to be unmistakable
    const exact = span.filter((t, i) => words[i].kind === "SAME");
    if (!exact.length) return null;
    if (exact.every((t) => GENERIC_WORDS.has(t.key)) && letters < 7) return null;
  }
  const confidence = Math.min(...kinds.map((k) => TYPO_CONFIDENCE[k])) - 0.1 * (edits - 1);
  return { kind: kinds.length === 1 ? kinds[0] : "MIXED", edits, confidence: Math.round(confidence * 100) / 100 };
}
