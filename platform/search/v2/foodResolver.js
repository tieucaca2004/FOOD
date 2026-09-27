// SEARCH INTELLIGENCE V2 — step 3a: FOOD_ENTITY resolution (read-only snapshot).
//
// Whole names first (TermMatcher: canonical published names + APPROVED relations; accents typed are respected,
// missing ones forgiven; a one-word accented dish is not matched from its unaccented spelling; typos are only
// candidates). Then SHORTENED language: typed words that are the beginning of several published names are
// AMBIGUOUS ("bún bò" -> Bún bò Huế / Bún bò Nam Bộ, "banh" -> many) — never broadened to the one-word family
// ("Bún") and never guessed.
import { toneSig } from "./normalize.js";
import { wordClass } from "./lexicon.js";

const MATCH_CLASS = {
  CANONICAL: "EXACT_CANONICAL",
  EXACT_ALIAS: "APPROVED_ALIAS",
  SPELLING_VARIANT: "APPROVED_ALIAS",
  COMMON_QUERY: "APPROVED_ALIAS",
  ABBREVIATION: "APPROVED_ALIAS",
  DIACRITIC_VARIANT: "APPROVED_NO_DIACRITIC",
  REGIONAL_ALIAS: "APPROVED_REGIONAL",
  INPUT_VARIANT: "APPROVED_TYPO",
};
const MAX_RUN = 4;

/** Token indexes of `spanText` (a matcher span) in `tokens`, first free occurrence; null when not found. */
function locate(tokens, spanText, used) {
  const words = spanText.split(/[^\p{L}\p{N}]+/u).filter(Boolean).map((w) => w.normalize("NFC").toLowerCase());
  for (let i = 0; i + words.length <= tokens.length; i++) {
    if (words.every((w, j) => tokens[i + j].lower === w && !used.has(i + j))) return Array.from(words, (_, j) => i + j);
  }
  return null;
}

// a typed word agrees with a name word: accents typed must be the same (tone position ignored); missing ones forgiven
const agrees = (typed, word) => (typed.accented ? toneSig(typed.lower) === toneSig(word.lower) : typed.folded === word.folded);

export class FoodResolver {
  /**
   * @param {{matcher: object, foods: {id: number, key: string, name: string, words: {lower: string, folded: string}[], merchants: number}[]}} deps
   *   matcher: TermMatcher over canonical published names + approved relations; foods: the published dish list
   *   (merchants = recorded places, only to ORDER candidates — never a ranking of quality)
   */
  constructor({ matcher, foods }) {
    this.matcher = matcher;
    this.foods = foods;
    this.byId = new Map(foods.map((f) => [f.id, f]));
  }

  /**
   * @param {object} input normalizeInput() result
   * @param {Set<number>} blocked token indexes already used (price, exclusion…)
   */
  resolve(input, blocked = new Set()) {
    const tokens = input.tokens;
    const out = { foods: [], candidates: [], suggestions: [], regions: [], contextReference: false, used: new Set() };
    const text = tokens.filter((t) => !blocked.has(t.i)).map((t) => t.original).join(" ");
    if (!text) return out;
    const r = this.matcher.match(text);
    out.contextReference = r.contextReference;
    const used = new Set(blocked);
    const take = (span) => {
      const idx = locate(tokens, span, used);
      if (idx) idx.forEach((i) => used.add(i));
      return idx;
    };
    for (const m of r.modifiers.filter((x) => x.type === "region")) {
      const idx = take(m.text);
      if (idx) out.regions.push({ regionId: m.regionId, name: m.name, tokens: idx });
    }
    const food = (id) => this.byId.get(id);
    for (const m of r.matches) {
      const f = food(m.foodEntityId);
      const idx = take(m.text);
      if (!f || !idx) continue;
      const forgiven = idx.some((i, j) => !tokens[i].accented && f.words[j] && f.words[j].lower !== f.words[j].folded);
      const cls = m.relationType === "CANONICAL" && forgiven ? "APPROVED_NO_DIACRITIC" : MATCH_CLASS[m.relationType] ?? "TOKEN_MATCH";
      out.foods.push({ id: f.id, key: f.key, name: f.name, said: m.text, tokens: idx, matchType: cls, confidence: m.typo ? m.typo.confidence : 1 });
    }
    for (const a of r.ambiguous) {
      const idx = take(a.text);
      const options = [...new Map(a.candidates.map((c) => [c.foodEntityId, food(c.foodEntityId)])).values()].filter(Boolean);
      if (idx && options.length) out.candidates.push({ said: a.text, tokens: idx, options, reason: a.fuzzy ? "TYPO_CANDIDATES" : "AMBIGUOUS_TERM" });
    }
    for (const s of r.suggestions) {
      const idx = take(s.text);
      const f = food(s.foodEntityId);
      if (idx && f) out.suggestions.push({ said: s.text, tokens: idx, food: f, reason: s.typo?.kind ?? "TYPO", confidence: s.typo?.confidence ?? null });
    }
    out.used = used;
    return out;
  }

  // Shortened language: a one-word dish followed by more words, or words no whole name matched, that BEGIN
  // several published names -> candidates (one -> a suggestion to confirm). Run AFTER place-name resolution:
  // a place's own name words ("Cô Ba") are never read as the start of a dish name.
  // notDishStart: attribute / ingredient words ("hải sản", "mực"): they never START a dish name (they may continue
  // one: "bún BÒ")
  applyPrefixes(input, out, notDishStart = new Set()) {
    const tokens = input.tokens;
    const used = out.used;
    const oneWord = new Map(out.foods.filter((f) => f.tokens.length === 1).map((f) => [f.tokens[0], f]));
    for (let i = 0; i < tokens.length; i++) {
      const single = oneWord.get(i);
      if ((used.has(i) && !single) || wordClass(tokens[i]) !== "required" || (!single && notDishStart.has(i))) continue;
      const run = [i];
      for (let j = i + 1; j < tokens.length && run.length < MAX_RUN && !used.has(j) && wordClass(tokens[j]) === "required"; j++) run.push(j);
      for (let len = run.length; len >= (single ? 2 : 1); len--) {
        const typed = run.slice(0, len).map((k) => tokens[k]);
        const options = this.foods.filter((f) => {
          if (f.words.length < len || !typed.every((t, k) => agrees(t, f.words[k]))) return false;
          // a longer name; or, typed without any accents, the one-word name it folds to ("pho" -> Phở)
          return f.words.length > len || (!single && typed.every((t) => !t.accented) && f.words.some((w) => w.lower !== w.folded));
        });
        if (!options.length) continue;
        options.sort((a, b) => b.merchants - a.merchants || a.words.length - b.words.length || a.name.localeCompare(b.name, "vi"));
        const idx = run.slice(0, len);
        idx.forEach((k) => used.add(k));
        if (single) out.foods.splice(out.foods.indexOf(single), 1);
        const said = typed.map((t) => t.original).join(" ");
        if (options.length === 1) out.suggestions.push({ said, tokens: idx, food: options[0], reason: "PREFIX" });
        else out.candidates.push({ said, tokens: idx, options, reason: "SHORTENED" });
        i = idx.at(-1);
        break;
      }
    }
    return out;
  }
}
