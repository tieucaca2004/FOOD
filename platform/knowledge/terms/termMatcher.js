import { lowerNfc, termKey, tokens, onlyGenericWords, hasDiacritics } from "./termNormalize.js";
import { toneSig, spanTypo } from "./termFuzzy.js";

// Deterministic term matcher: INPUT -> NORMALIZE -> CANDIDATE MATCH -> RELATION VALIDATION -> CANONICAL FOOD.
// Built from a SNAPSHOT of approved data only (canonical dishes + APPROVED relations); it never reads or writes
// the database itself, and matching a message never creates anything.
//
//   * whole words only, longest span first ("cá" never matches inside "bún cá", nor "bún cá" from "cá");
//   * accents the customer TYPED are respected (tràng ≠ Trang), missing ones are forgiven ("bun ca" -> Bún cá) —
//     except for a one-word accented name ("Giò", "Cốm"): unaccented "gio" / "com" only match through an APPROVED
//     DIACRITIC_VARIANT (they collide with everyday words);
//   * RELATED_TERM is reported, never resolved; DISALLOWED_TERM blocks its dish (or every dish);
//   * a term naming several dishes is AMBIGUOUS: candidates are returned, nothing is chosen;
//   * the tone mark may sit on either vowel ("hoà" = "hòa");
//   * typos and typing variants are CANDIDATES only (termFuzzy.js): one candidate is a SUGGESTION to confirm,
//     several are AMBIGUOUS; only a candidate at or above `resolveTypoAt` resolves (by default: a clean
//     Telex / VNI decoding, "bun cas" -> Bún cá). Nothing learned from input is ever stored;
//   * a region name is a modifier ("bún cá Nha Trang" = Bún cá + Nha Trang), never part of an alias;
//   * a REGIONAL_ALIAS names the dish wherever it is said, and reports whether the conversation's region (given,
//     or named in the message) is inside the alias's region ("in"), outside ("out") or unknown;
//   * "món đó / món này" is a reference to the conversation's context, not a dish.

const NAMING = new Set(["CANONICAL", "EXACT_ALIAS", "SPELLING_VARIANT", "DIACRITIC_VARIANT", "COMMON_QUERY", "ABBREVIATION", "REGIONAL_ALIAS"]);
const CONTEXT_REFERENCE = /(?:^|[^\p{L}])(?:món|quán|cái|chỗ|mon|quan|cai|cho)\s+(?:đó|này|kia|ấy|do|nay|kia|ay)(?:$|[^\p{L}])/iu;
const MAX_SPAN = 6;

export class TermMatcher {
  /**
   * @param {{canonicals: {foodEntityId: number, canonicalName: string}[], relations: object[], regions?: {id, name, parent_id}[], regionNames?: ({regionId, name}|string)[]}} snapshot
   *   relations: APPROVED rows of kb_term_relations (the caller filters; the matcher never sees anything else)
   */
  constructor({ canonicals, relations, regions = [], regionNames = [], resolveTypoAt = 0.95 }) {
    this.resolveTypoAt = resolveTypoAt;
    this.parent = new Map(regions.map((r) => [r.id, r.parent_id ?? null]));
    this.index = new Map(); // term key -> entries
    this.disallowed = new Map(); // term key -> Set(foodEntityId | 0 for every dish)
    this.regions = new Map(
      [...regions.map((r) => ({ regionId: r.id, name: r.name })), ...regionNames.map((n) => (typeof n === "string" ? { regionId: null, name: n } : n))]
        .map((n) => [termKey(n.name), n])
        .filter(([k]) => k)
    );
    const add = (key, entry) => {
      if (!key || onlyGenericWords(key)) return;
      if (!this.index.has(key)) this.index.set(key, []);
      this.index.get(key).push(entry);
    };
    for (const c of canonicals) {
      add(termKey(c.canonicalName), { foodEntityId: c.foodEntityId, canonicalName: c.canonicalName, relationType: "CANONICAL", relationId: null, term: c.canonicalName, confidence: 1 });
    }
    for (const r of relations) {
      if (r.status !== "APPROVED") continue; // belt and braces: only approved relations exist here
      if (r.relation_type === "DISALLOWED_TERM") {
        if (!this.disallowed.has(r.term_key)) this.disallowed.set(r.term_key, new Set());
        this.disallowed.get(r.term_key).add(r.food_entity_id ?? 0);
        continue;
      }
      add(r.term_key, { foodEntityId: r.food_entity_id, canonicalName: r.canonical_name, relationType: r.relation_type, relationId: r.id, term: r.term, confidence: r.confidence, regionId: r.region_id ?? null });
    }
    this.maxSpan = Math.min(MAX_SPAN, Math.max(1, ...[...this.index.keys()].map((k) => k.split(" ").length)));
  }

  // Accents typed are respected, missing ones forgiven — per word.
  _accentOk(spanTokens, entry) {
    const termWords = lowerNfc(entry.term).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    if (termWords.length !== spanTokens.length) return entry.relationType !== "CANONICAL" || !hasDiacritics(entry.term); // punctuation-split terms: key match only
    let forgiven = false;
    for (let i = 0; i < spanTokens.length; i++) {
      if (hasDiacritics(spanTokens[i].original)) {
        if (toneSig(spanTokens[i].original) !== toneSig(termWords[i])) return false; // tone placement does not matter
      } else if (hasDiacritics(termWords[i])) forgiven = true;
    }
    // a one-word accented name is not matched from its unaccented spelling (only via an approved DIACRITIC_VARIANT)
    if (forgiven && spanTokens.length === 1 && entry.relationType !== "DIACRITIC_VARIANT") return false;
    // a DIACRITIC_VARIANT is the unaccented spelling: it matches what was typed without accents
    if (entry.relationType === "DIACRITIC_VARIANT" && spanTokens.some((t) => hasDiacritics(t.original))) return false;
    return true;
  }

  // is region `a` the region `b` or inside it?
  _within(a, b) {
    for (let r = a, guard = 0; r && guard < 20; r = this.parent.get(r), guard++) if (r === b) return true;
    return false;
  }

  /**
   * @param {string} text
   * @param {{regionId?: string|null}} [opts] the conversation's region, if known (a region named in the text also counts)
   * @returns {{status: "resolved"|"ambiguous"|"suggested"|"none", matches: object[], ambiguous: object[], related: object[], suggestions: object[], modifiers: object[], contextReference: boolean}}
   */
  match(text, { regionId = null } = {}) {
    const toks = tokens(text);
    const out = { matches: [], ambiguous: [], related: [], suggestions: [], modifiers: [], contextReference: CONTEXT_REFERENCE.test(lowerNfc(text)) };
    const used = new Array(toks.length).fill(false);
    const soft = new Array(toks.length).fill(null); // a one-word dish match: a longer slip over it may be what was meant
    for (let i = 0; i < toks.length; i++) {
      if (used[i]) continue;
      for (let n = Math.min(this.maxSpan, toks.length - i); n >= 1; n--) {
        const span = toks.slice(i, i + n);
        const key = span.map((t) => t.key).join(" ");
        if (this.regions.has(key)) {
          out.modifiers.push({ type: "region", text: span.map((t) => t.original).join(" "), name: this.regions.get(key).name, regionId: this.regions.get(key).regionId });
          span.forEach((_, j) => (used[i + j] = true));
          break;
        }
        const blocked = this.disallowed.get(key);
        if (blocked?.has(0)) {
          span.forEach((_, j) => (used[i + j] = true)); // blocked for every dish
          break;
        }
        const entries = (this.index.get(key) ?? []).filter((e) => !blocked?.has(e.foodEntityId) && this._accentOk(span, e));
        if (!entries.length) continue;
        const text = span.map((t) => t.original).join(" ");
        const naming = entries.filter((e) => NAMING.has(e.relationType));
        const foods = [...new Map(naming.map((e) => [e.foodEntityId, e])).values()];
        if (foods.length === 1) {
          out.matches.push({ text, ...foods[0] });
          if (n === 1) soft[i] = out.matches.at(-1);
        }
        else if (foods.length > 1) out.ambiguous.push({ text, candidates: foods });
        else out.related.push(...entries.filter((e) => e.relationType === "RELATED_TERM").map((e) => ({ text, ...e })));
        span.forEach((_, j) => (used[i + j] = true));
        break;
      }
    }
    // a regional name: said inside its region, outside it, or nobody knows where
    const where = regionId ?? out.modifiers.find((m) => m.regionId)?.regionId ?? null;
    for (const m of out.matches) if (m.relationType === "REGIONAL_ALIAS") m.regionMatch = where ? (this._within(where, m.regionId) ? "in" : "out") : "unknown";
    this._typos(toks, used, out, soft);
    out.status = out.ambiguous.length ? "ambiguous" : out.matches.length ? "resolved" : out.suggestions.length ? "suggested" : "none";
    return out;
  }

  // Typos / typing variants of the words no exact rule used: candidates, never guesses (termFuzzy.js).
  // A longer name with a slip beats a one-word dish inside it ("bún cáa" is "Bún cá?", not "Bún"): that one-word
  // match is withdrawn and the longer name is only a candidate.
  _typos(toks, used, out, soft = []) {
    const found = [];
    for (let i = 0; i < toks.length; i++) {
      for (let n = Math.min(this.maxSpan, toks.length - i); n >= 1; n--) {
        const blockers = used.slice(i, i + n).map((u, j) => u && !(n >= 2 && soft[i + j]));
        if (blockers.some(Boolean) || used.slice(i, i + n).every(Boolean)) continue;
        const span = toks.slice(i, i + n);
        const spanKey = span.map((t) => t.key).join(" ");
        if (onlyGenericWords(spanKey) || span.some((t) => /^\d+$/.test(t.key))) continue;
        const letters = spanKey.replace(/ /g, "").length;
        for (const [key, entries] of this.index) {
          const words = key.split(" ");
          if (words.length !== n || Math.abs(words.join("").length - letters) > 4) continue; // prefilter only (Telex spellings run long); spanTypo decides
          for (const e of entries) {
            if (!NAMING.has(e.relationType) || this.disallowed.get(spanKey)?.has(e.foodEntityId) || this.disallowed.get(spanKey)?.has(0)) continue;
            const termWords = lowerNfc(e.term).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
            if (termWords.length !== n) continue;
            const typo = spanTypo(span, words, termWords);
            if (typo) found.push({ start: i, n, text: span.map((t) => t.original).join(" "), entry: e, typo });
          }
        }
      }
    }
    // longest span first; a span overlapping a chosen one is dropped
    found.sort((a, b) => b.n - a.n || a.start - b.start || b.typo.confidence - a.typo.confidence);
    const taken = new Array(toks.length).fill(false);
    const groups = new Map();
    for (const c of found) {
      const k = `${c.start}:${c.n}`;
      if (!groups.has(k)) {
        if (taken.slice(c.start, c.start + c.n).some(Boolean)) continue;
        taken.fill(true, c.start, c.start + c.n);
        groups.set(k, []);
        for (let j = c.start; j < c.start + c.n; j++) {
          const at = soft[j] ? out.matches.indexOf(soft[j]) : -1;
          if (at >= 0) out.matches.splice(at, 1);
        }
      }
      groups.get(k).push(c);
    }
    for (const group of groups.values()) {
      const byFood = new Map();
      for (const c of group) if (!byFood.has(c.entry.foodEntityId) || byFood.get(c.entry.foodEntityId).typo.confidence < c.typo.confidence) byFood.set(c.entry.foodEntityId, c);
      const cands = [...byFood.values()];
      const typoOf = (c) => ({ kind: c.typo.kind, edits: c.typo.edits, confidence: c.typo.confidence });
      if (cands.length > 1) {
        out.ambiguous.push({ text: group[0].text, fuzzy: true, candidates: cands.map((c) => ({ ...c.entry, typo: typoOf(c) })) });
      } else if (cands[0].typo.confidence >= this.resolveTypoAt) {
        out.matches.push({ text: cands[0].text, ...cands[0].entry, relationType: "INPUT_VARIANT", via: cands[0].entry.relationType, typo: typoOf(cands[0]) });
      } else {
        out.suggestions.push({ text: cands[0].text, ...cands[0].entry, suggestion: true, typo: typoOf(cands[0]) });
      }
    }
  }
}
