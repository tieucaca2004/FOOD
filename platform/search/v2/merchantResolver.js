// SEARCH INTELLIGENCE V2 — step 3b: MERCHANT resolution (read-only snapshot).
//
// A place is found by the words of its OWN name, independent of any dish keyword: "Kiwami", "Vfruit",
// "Bánh căn Út Năm ở đâu" (the operation words are not part of the name).
//   brand words  (required) weighted by rarity across place names — a word used by one place identifies it,
//                "Hải" alone identifies nothing; a word may match the name (1) or the written address (0.8), but
//                the NAME must carry at least one of them
//   dish words   (soft) the dish / attribute words the customer said next to the name ("PHỞ Hồng", "BÁNH MÌ
//                Phan"): more than half of them must be in the place's name — "Bánh bèo Phan Bội Châu" is not
//                "Bánh Mì Phan", "Bún ốc Hồng Ngọc" is not "Phở Hồng"
//   typing slips a brand word one letter off a RARE name word ("honng" -> "Hồng") is retried once, and the result
//                is never better than MEDIUM (a "tên gần giống" candidate, never a confirmed place)
// Accents typed must agree (tone position ignored); a name recorded without accents matches on letters.
import { normalizeInput, toneSig, foldText } from "./normalize.js";

// (the search layer does not import the knowledge layer — architecture boundary: only the read-only adapter does)
// "số 52 đường Cù Huân, …" -> "52 cu huan" (same rule as the collector's same-place key); null without a number
function addressKey(address) {
  const first = foldText(String(address).split(/[,;(]/)[0]).replace(/[^a-z0-9]+/g, " ").trim();
  const key = first.replace(/^so\s+/, "").replace(/^(\S+)\s+(?:duong|pho)\s+/, "$1 ");
  return /^\d/.test(key) ? key : null;
}

function editDistance(a, b) {
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

const STRONG_DF = 30; // a word used by at most this many place names is distinctive on its own
const DISTINCT_SET = 12; // …or all asked words together name at most this many places
const ADDRESS_WEIGHT = 0.8;
const MEDIUM_COVERAGE = 0.45;
const SAME_ADDRESS_SLACK = 0.15; // a slightly weaker record of the SAME written address joins the best group
const MAX_PLACES = 6; // more distinct addresses than this for one name: ask, never list them all as "the" place
export const HIGH = "HIGH_CONFIDENCE";
export const MEDIUM = "MEDIUM_CONFIDENCE";
export const AMBIGUOUS = "AMBIGUOUS";
export const NO_MATCH = "NO_MATCH";

// a place's name is a name: every word of it counts ("Pho HONG in Nha Trang" — "hong" is not filler there)
const words = (text) => normalizeInput(text).tokens;
// 1: same word (accents typed agree, tone position ignored; or neither side accented); LOOSE: the customer typed
// accents the record does not have ("Chàng" vs a recorded "Chang") — letters agree, the word may not; 0: different
const LOOSE = 0.6;
const agree = (t, w) => (t.folded !== w.folded ? 0 : !t.accented || !w.accented ? (t.accented && !w.accented ? LOOSE : 1) : toneSig(w.lower) === toneSig(t.lower) ? 1 : 0);
const bestAgree = (t, list) => Math.max(0, ...list.map((w) => agree(t, w)));
const same = (t) => (w) => agree(t, w) === 1;

export class MerchantIndex {
  /** @param {{merchants: {id: string, name: string, address: string|null, kind: "kb"|"catalog"}[]}} deps */
  constructor({ merchants }) {
    this.merchants = merchants.map((m) => ({ ...m, nameWords: words(m.name), addressWords: words(m.address ?? ""), key: (m.address && addressKey(m.address)) || `id:${m.id}` }));
    this.df = new Map();
    for (const m of this.merchants) for (const f of new Set(m.nameWords.map((w) => w.folded))) this.df.set(f, (this.df.get(f) ?? 0) + 1);
    this.n = this.merchants.length;
    this.rareWords = [...this.df.entries()].filter(([w, df]) => df <= STRONG_DF && w.length >= 3 && !/^\d+$/.test(w)).map(([w]) => w);
  }

  idf(folded) {
    return Math.log(1 + this.n / (1 + (this.df.get(folded) ?? 0)));
  }

  // how well a typed word is carried by a place: its name (1, or LOOSE), else its written address (0.8), else 0
  _hit(m, t) {
    const inName = bestAgree(t, m.nameWords);
    if (inName) return inName;
    return bestAgree(t, m.addressWords) === 1 ? ADDRESS_WEIGHT : 0;
  }

  /**
   * @param {{required: object[], soft?: object[], optional?: object[]}} q typed tokens (normalizeInput tokens):
   *   required = brand words, soft = dish / attribute words said with them, optional = filler that may be a name word
   * @returns {{confidence: string, candidates: object[], groups: object[][], total: number, corrected: object|null}}
   */
  resolve({ required, soft = [], optional = [] }) {
    const first = this._resolve(required, soft, optional);
    if (first.confidence !== NO_MATCH || !required.length) return first;
    // one typing slip in a brand word, against rare name words only
    for (const [k, t] of required.entries()) {
      if (t.folded.length < 4 || this.df.has(t.folded)) continue;
      const near = this.rareWords.filter((w) => Math.abs(w.length - t.folded.length) <= 1 && editDistance(w, t.folded) === 1);
      if (near.length !== 1) continue;
      const fixed = required.map((x, j) => (j === k ? { ...x, lower: near[0], folded: near[0], accented: false } : x));
      const retry = this._resolve(fixed, soft, optional);
      if (retry.confidence === HIGH || retry.confidence === MEDIUM) return { ...retry, confidence: MEDIUM, corrected: { said: t.original, as: near[0] } };
    }
    return first;
  }

  _resolve(required, soft, optional) {
    const none = { confidence: NO_MATCH, candidates: [], groups: [], total: 0, corrected: null };
    if (!required.length) return none;
    // a lone word must be a real name word: not a bare number, at least 3 letters
    if (required.length === 1 && (/^\d+$/.test(required[0].folded) || required[0].folded.length < 3)) return none;
    const weights = required.map((t) => this.idf(t.folded));
    const total = weights.reduce((a, b) => a + b, 0);
    const scored = [];
    for (const m of this.merchants) {
      let got = 0;
      let hits = 0;
      let inName = 0;
      let strong = false;
      required.forEach((t, k) => {
        const h = this._hit(m, t);
        if (!h) return;
        got += weights[k] * h;
        hits += 1;
        if (h === 1) inName += 1; // a LOOSE match is carried by the name, but weakly
        if (h === 1 && !/^\d+$/.test(t.folded) && (this.df.get(t.folded) ?? 0) <= STRONG_DF) strong = true;
      });
      if (!got || !required.some((t) => bestAgree(t, m.nameWords) > 0)) continue; // the NAME must carry at least one asked word (an address alone is not the place)
      const softHits = soft.filter((t) => m.nameWords.some(same(t))).length;
      const unique = required.some((t) => (this.df.get(t.folded) ?? 0) === 1 && m.nameWords.some(same(t))); // a word ONLY this place's name has
      const bonus = optional.reduce((a, t) => a + (m.nameWords.some(same(t)) ? 0.01 : 0), 0) + (soft.length ? softHits / soft.length / 100 : 0);
      scored.push({ m, coverage: got / total, full: hits === required.length, fullInName: inName === required.length, strong, inName, bonus, softHits, unique });
    }
    if (!scored.length) return none;
    // all asked words together, in the NAME, name few places: distinctive as a whole ("Cô Ba", "Hải Mập", "Năm Beo")
    const full = scored.filter((s) => s.fullInName);
    const combo = full.length && full.length <= DISTINCT_SET && required.length >= 2;
    if (combo) full.forEach((s) => (s.strong = true));
    // the dish words said with the name must be this place's (more than half of them) — relaxed to one of them for
    // a distinctive combination of name words, and waived for a name word no other place uses ("Vfruit")
    // (the waiver needs a name that says nothing about dishes of that kind: "Bánh bèo Phan …" shares "bánh" with "Bánh Mì Phan" and is another place)
    const dishOk = (s) => !soft.length || (s.unique && s.softHits === 0) || s.softHits * 2 > soft.length || (combo && s.full && s.softHits >= 1);
    for (let k = scored.length - 1; k >= 0; k--) if (!dishOk(scored[k])) scored.splice(k, 1);
    if (!scored.length) return none;
    const usable = scored.filter((s) => s.strong && s.coverage >= MEDIUM_COVERAGE);
    if (!usable.length) return none;
    const best = Math.max(...usable.map((s) => s.coverage));
    const bestKeys = new Set(usable.filter((s) => s.coverage >= best - 0.001).map((s) => s.m.key));
    const top = usable
      .filter((s) => s.coverage >= best - 0.001 || (s.coverage >= best - SAME_ADDRESS_SLACK && bestKeys.has(s.m.key)))
      .sort((a, b) => b.bonus - a.bonus || b.inName - a.inName || a.m.nameWords.length - b.m.nameWords.length || a.m.name.localeCompare(b.m.name, "vi"));
    // the same place listed by several sources (same written address) is ONE place with several records
    const byAddress = new Map();
    for (const s of top) {
      if (!byAddress.has(s.m.key)) byAddress.set(s.m.key, []);
      byAddress.get(s.m.key).push({ id: s.m.id, name: s.m.name, address: s.m.address, kind: s.m.kind, coverage: Number(s.coverage.toFixed(3)) });
    }
    const groups = [...byAddress.values()];
    const confidence = groups.length > MAX_PLACES ? AMBIGUOUS : top.some((s) => s.full) ? HIGH : MEDIUM;
    return { confidence, candidates: groups.flat(), groups, total: groups.length, corrected: null };
  }
}
