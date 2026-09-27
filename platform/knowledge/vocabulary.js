import fs from "node:fs";
import { fold, collapseWhitespace, hasDiacritics, nfc } from "./text.js";

// Semantic vocabulary: finds taxonomy concepts in Vietnamese text
// (lexicon/vocabulary.json). Deterministic — no model call. Used by the
// validator to check that a quote actually SUPPORTS a proposed claim, and
// later by the semantic parser (customer questions -> filters).
//
// Order of precedence inside a text:
//   1. out-of-scope phrases ("tính nóng" — traditional medicine) claim their span
//   2. protected dish names ("cơm nguội", "bánh bò") claim their span
//   3. terms, longest first; a span is never matched twice
// Accents: accented input is matched on accented text. Unaccented input is
// matched on folded text, and a term whose folded form collides with another
// word (chua/chưa, kho/khô, bò/bỏ) yields an AMBIGUOUS match there.

const VOCABULARY_URL = new URL("./lexicon/vocabulary.json", import.meta.url);

export function loadVocabularyJson() {
  return JSON.parse(fs.readFileSync(VOCABULARY_URL, "utf8"));
}

// Words after a term that raise/lower it ("cay lắm", "ngọt vừa").
const POST_INTENSIFIERS = { "lắm": "high", "quá": "high", "nhiều": "high", "vừa": "medium", "vừa phải": "medium" };
const CLAUSE_BREAK = /[,.;:!?\n—–()]/;
const WORD = "[\\p{L}\\p{N}]";

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function conceptsOf(term) {
  if (term.senses) return null; // resolved per occurrence
  if (term.concepts) return term.concepts;
  return [{ concept: term.concept, value: term.value, level: term.level }];
}

/** Problems of a vocabulary against a taxonomy (empty = valid). */
export function validateVocabulary(vocab, taxonomy) {
  const problems = [];
  const seen = new Set();
  const checkConcept = (c, where) => {
    if (c.concept === "ingredient") {
      if (!taxonomy.hasIngredient(c.value)) problems.push(`${where}: unknown ingredient "${c.value}"`);
    } else if (String(c.concept).startsWith("facet:")) {
      const facet = c.concept.slice(6);
      if (!taxonomy.hasFacetNode(facet, c.value)) problems.push(`${where}: unknown facet node ${facet}/${c.value}`);
    } else {
      const attr = taxonomy.attribute(c.concept);
      if (!attr) problems.push(`${where}: unknown attribute "${c.concept}"`);
      else if (attr.type === "enum" && !(c.value in attr.values)) problems.push(`${where}: "${c.value}" is not a value of ${c.concept}`);
      else if (attr.type === "graded" && c.value !== undefined) problems.push(`${where}: graded ${c.concept} takes a level, not a value`);
      if (c.level !== undefined && !taxonomy.levels.has(c.level)) problems.push(`${where}: unknown level "${c.level}"`);
    }
  };
  for (const term of vocab.terms) {
    const key = nfc(term.text).toLowerCase();
    if (seen.has(key)) problems.push(`duplicate term "${term.text}"`);
    seen.add(key);
    if (term.senses) {
      if (term.senses.filter((s) => s.default).length !== 1) problems.push(`term "${term.text}": exactly one default sense required`);
      term.senses.forEach((s) => checkConcept(s, `term "${term.text}"`));
    } else {
      conceptsOf(term).forEach((c) => checkConcept(c, `term "${term.text}"`));
    }
  }
  for (const o of vocab.out_of_scope) {
    if (!taxonomy.isExcludedConcept(o.concept)) problems.push(`out_of_scope "${o.text}": "${o.concept}" is not an excluded concept`);
  }
  for (const level of Object.values(vocab.intensifiers)) {
    if (!taxonomy.levels.has(level)) problems.push(`intensifier level "${level}" unknown`);
  }
  return problems;
}

export class FoodVocabulary {
  constructor(json = loadVocabularyJson(), taxonomy = null) {
    if (taxonomy) {
      const problems = validateVocabulary(json, taxonomy);
      if (problems.length) throw new Error(`invalid vocabulary: ${problems.join("; ")}`);
    }
    this.json = json;
    // longest first, so "cay nóng" wins over "nóng", "mắm tôm" over "tôm"
    this.terms = [...json.terms].sort((a, b) => b.text.length - a.text.length);
    this.negators = json.negators.map((n) => nfc(n).toLowerCase()).filter((n) => !n.includes(" "));
    this.intensifiers = json.intensifiers;
    const texts = new Set(json.terms.map((t) => nfc(t.text).toLowerCase()));
    // single words that have their own doubled entry ("chua chua") — that entry wins over reduplication
    this.explicitDoubles = new Set(json.terms.map((t) => nfc(t.text).toLowerCase()).filter((w) => !w.includes(" ") && texts.has(`${w} ${w}`)));
    // unaccented words that collide with another word — a phrase built on one
    // ("chua chua", "chua cay") inherits the ambiguity unless marked unaccented_safe
    this.ambiguousWords = new Set(json.terms.filter((t) => t.ambiguous_unaccented && !t.text.includes(" ")).map((t) => fold(t.text).folded));
    this._regexCache = new Map();
  }

  _regex(pattern) {
    let re = this._regexCache.get(pattern);
    if (!re) {
      re = new RegExp(pattern, "gu");
      this._regexCache.set(pattern, re);
    }
    re.lastIndex = 0;
    return re;
  }

  /**
   * @returns {{matches: Array<{text, term, concept, value, level, negated, ambiguous, reduplicated, start, end}>,
   *            protected: Array<{text, start, end}>, outOfScope: Array<{text, concept, start, end}>}}
   * Offsets refer to the whitespace-collapsed NFC text.
   */
  match(text) {
    const clean = collapseWhitespace(text);
    const { original, folded } = fold(clean);
    const accented = hasDiacritics(clean);
    const hay = accented ? original : folded;
    const key = (s) => (accented ? nfc(s).toLowerCase() : fold(s).folded);
    const taken = [];
    const free = (s, e) => !taken.some(([a, b]) => s < b && e > a);
    const find = (phrase) => {
      const k = key(phrase);
      if (!hay.includes(k)) return [];
      const re = this._regex(`(?<!${WORD})${escapeRegex(k)}(?!${WORD})`);
      return [...hay.matchAll(re)].map((m) => [m.index, m.index + m[0].length]);
    };

    const outOfScope = [];
    for (const o of this.json.out_of_scope) {
      for (const [s, e] of find(o.text)) if (free(s, e)) {
        taken.push([s, e]);
        outOfScope.push({ text: clean.slice(s, e), concept: o.concept, start: s, end: e });
      }
    }
    const protectedNames = [];
    for (const p of this.json.protected_names) {
      for (const [s, e] of find(p.text)) if (free(s, e)) {
        taken.push([s, e]);
        protectedNames.push({ text: clean.slice(s, e), reason: p.reason, start: s, end: e });
      }
    }

    const raw = [];
    // Reduplication first ("nóng nóng cay cay" = hot + a bit spicy): a
    // doubled single word is one softened mention, and must not be split by
    // a longer term across it ("nóng cay").
    for (const term of this.terms) {
      if (term.text.includes(" ")) continue;
      if (this.explicitDoubles.has(nfc(term.text).toLowerCase())) continue; // an explicit term ("chua chua") wins
      const k = key(term.text);
      if (!hay.includes(`${k} ${k}`)) continue;
      const w = escapeRegex(k);
      const re = this._regex(`(?<!${WORD})${w}\\s+${w}(?!${WORD})`);
      for (const m of hay.matchAll(re)) {
        const [s, e] = [m.index, m.index + m[0].length];
        if (!free(s, e)) continue;
        taken.push([s, e]);
        raw.push({ term, s, e, reduplicated: true });
      }
    }
    for (const term of this.terms) {
      for (const [s, e] of find(term.text)) {
        if (!free(s, e)) continue;
        taken.push([s, e]);
        raw.push({ term, s, e });
      }
    }
    raw.sort((a, b) => a.s - b.s);

    const matches = [];
    for (let i = 0; i < raw.length; i++) {
      const { term, s } = raw[i];
      let { e } = raw[i];
      // "cay cay", "nóng nóng": one softened mention
      let reduplicated = Boolean(raw[i].reduplicated);
      if (!reduplicated && raw[i + 1] && raw[i + 1].term === term && hay.slice(e, raw[i + 1].s).trim() === "") {
        e = raw[i + 1].e;
        reduplicated = true;
        i++;
      }
      const before = this._clauseWords(hay.slice(0, s), -3);
      const after = this._clauseWords(hay.slice(e), 2);
      const negated = before.some((w) => this.negators.includes(w) || this.negators.map((n) => fold(n).folded).includes(w) && !accented);
      const alternatives = this._alternatives(term, accented);
      const builtOnAmbiguous = !accented && !term.unaccented_safe && term.text.includes(" ") && fold(term.text).folded.split(" ").some((w) => this.ambiguousWords.has(w));
      const ambiguous = Boolean(term.always_ambiguous) || (!accented && Boolean(term.ambiguous_unaccented)) || builtOnAmbiguous || alternatives.length > 0;
      const concepts = term.senses ? [this._sense(term, before, after)] : conceptsOf(term);
      for (const c of concepts) {
        const graded = !String(c.concept).startsWith("facet:") && c.concept !== "ingredient" && c.value === undefined;
        const level = graded ? c.level ?? this._intensity(before, after) ?? null : null;
        matches.push({
          text: clean.slice(s, e),
          term: term.text,
          concept: c.concept,
          value: c.value ?? null,
          level,
          negated,
          ambiguous,
          alternatives,
          reduplicated,
          start: s,
          end: e,
        });
      }
    }
    return { matches, protected: protectedNames, outOfScope };
  }

  // Up to |n| words before (n < 0) or after (n > 0), never across a clause break.
  _clauseWords(text, n) {
    const part = n < 0 ? text.split(CLAUSE_BREAK).pop() : text.split(CLAUSE_BREAK)[0];
    const words = part.trim().split(/\s+/).filter(Boolean);
    return n < 0 ? words.slice(n) : words.slice(0, n);
  }

  // A sense applies only when its cue word is the word right before ("vị nóng"),
  // or anywhere in the clause for when_near; otherwise the default sense.
  _sense(term, before, after) {
    const same = (word, cue) => word === nfc(cue).toLowerCase() || word === fold(cue).folded;
    const prev = before[before.length - 1];
    const near = [...before, ...after];
    const hit = term.senses.find(
      (s) => (s.when_before && prev && s.when_before.some((c) => same(prev, c))) || (s.when_near && near.some((w) => s.when_near.some((c) => same(w, c))))
    );
    return hit ?? term.senses.find((s) => s.default);
  }

  // Unaccented input: the other terms that fold to the same text ("kho" -> kho / khô).
  _alternatives(term, accented) {
    if (accented) return [];
    const k = fold(term.text).folded;
    return this.terms.filter((t) => t !== term && fold(t.text).folded === k).map((t) => t.text);
  }

  _intensity(before, after) {
    const prev = before[before.length - 1];
    if (prev && this.intensifiers[prev]) return this.intensifiers[prev];
    const next = after[0];
    if (next && POST_INTENSIFIERS[next]) return POST_INTENSIFIERS[next];
    return null;
  }
}
