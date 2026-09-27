import { fold, normalizeName } from "../../../platform/knowledge/text.js";

// Deterministic extraction of food-entity PROPOSALS from sentences, using the
// reviewed vocabulary. Every proposal carries the sentence as its verbatim
// quote; the knowledge store's validator decides. Conservative by design:
//   - a sentence counts only if it names exactly ONE known dish (and it is
//     the dish being extracted) — "khác với bánh xèo, bánh căn…" is skipped;
//   - words INSIDE a dish name are never evidence ("nướng" in "nem nướng",
//     "bò" in "bún bò"): attributes come from the rest of the sentence;
//   - ambiguous terms are skipped; negation yields "none" only for graded
//     attributes and nothing for ingredients/facets;
//   - the role of an ingredient is not guessed ("unspecified").

const FACETS_FROM_TEXT = new Set(["dish_form", "carb_base", "preparation", "meal_period", "dough_base", "dietary", "cuisine"]);

/** Sentences of a paragraph (verbatim substrings; "…người Chăm.[1] Qua…" splits after the citation). */
export function splitSentences(text) {
  return String(text)
    .split(/(?<=[.!?](?:\[\d+\])*)\s+(?=[\p{Lu}"“(])/u)
    .map((s) => s.trim())
    .filter((s) => s.length >= 12);
}

/** [start, end) spans of any of `names` (whole words, accent-insensitive) in the sentence. */
export function nameSpans(sentence, names) {
  // accent-SENSITIVE for accented names ("phớ" is not "phở"); an unaccented name ("pho") only
  // matches text that is itself written without accents at that place
  const { original, folded } = fold(sentence);
  const spans = [];
  for (const name of names) {
    const f = fold(name);
    const key = f.folded.trim();
    if (!key) continue;
    const accented = f.original.trim() !== key;
    const needle = (accented ? f.original.trim() : key).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${needle}(?![\\p{L}\\p{N}])`, "gu");
    for (const m of (accented ? original : folded).matchAll(re)) {
      if (!accented && original.slice(m.index, m.index + m[0].length) !== m[0]) continue;
      spans.push([m.index, m.index + m[0].length, name]);
    }
  }
  return spans;
}

// Sentence-level signs that the sentence is NOT describing the dish in general.
const SKIP_SENTENCE = [
  /\b(?:cac mon|nhung mon|mon khac|loai khac|cac loai|mot so loai|cac thuc)\b/, // a list of OTHER dishes
  /\b(?:bien tau|bien the|phien ban|phong cach|kieu thu|loai thu|mon an noi tieng)\b/, // a variant / a regional version, not the typical dish
  /\b(?:thay vao do|thay vi|khong thay ai)\b/, // a contrast: what follows is something else
  /\b(?:tuong tu nhu|giong nhu|tuong tu)\b/, // a comparison: another dish is the subject
  /\blam gia\b/, // counterfeits
  /\b(?:ca biet|doi khi|co khi|co noi|tuy noi|tuy vung|hiem khi)\b/, // "cá biệt có bánh tét … tôm khô": an occasional version, not the typical dish
  /\b(?:bat ky|tuy thich|tuy y|tuy khau vi)\b/, // "có thể trộn với bất kỳ loại thịt hoặc rau": optional, not the dish
];
// "Ở România …", "Tại các tỉnh phía Nam …", "tại miền Nam": a regional variant
const REGIONAL_AREA = /(?:^|\s)(?:ở|tại)\s+(?:miền|phía|vùng|các tỉnh|các vùng|một số nơi|nhiều nơi)(?![\p{L}])/iu;
const REGIONAL_PLACE = /(?:^|\s)(?:[Ởở]|[Tt]ại)\s+\p{Lu}/u; // "ở/tại" + a capitalised place name
const isRegional = (s) => REGIONAL_AREA.test(s) || REGIONAL_PLACE.test(s);
// Nouns whose following taste/texture words describe THEM, not the dish.
const COMPONENT_NOUN = /(?:^|\s)(?:thịt|gạo|cơm|vỏ|lớp vỏ|nhân|sợi|nước|nước dùng|nước chấm|nước sốt|nước lèo|sốt|rau|lá|bột|ruột|da|xương|chả|sườn|giò|bì|hành tím|hành phi)(?:\s+\S+)?\s*$/iu;
const SERVED_WITH = /(?:ăn kèm|kèm với|kèm theo|dùng kèm|dùng với|bày kèm|dọn cùng|ăn cùng|ăn chung với|ăn với|chấm với|chấm cùng|nước chấm|chấm)(?![\p{L}])/iu;
const DISH_LEVEL_FACETS = FACETS_FROM_TEXT;
// "được cho là", "nhiều giả thiết cho rằng", "tương truyền": the source itself is not sure -> only a proposal
const HEDGED = /(?:được cho là|cho rằng|giả thiết|giả thuyết|có thể|có lẽ|tương truyền|người ta tin|chưa rõ|không rõ|nhiều khả năng)/iu;
const ORIGIN = /(?:có nguồn gốc|nguồn gốc|xuất xứ|bắt nguồn|du nhập|khởi nguồn)\s+(?:từ|ở|tại)\s+(?:(?:người|vùng|miền|tỉnh|thành phố|nước|xứ|đất)\s+)?/iu;

/**
 * @param {object} p
 * @param {string} p.sentence
 * @param {string} p.entityKey the dish the article is about
 * @param {Map<string, string[]>} p.namesByEntity every known dish -> its names
 * @param {import("../../../platform/knowledge/vocabulary.js").FoodVocabulary} p.vocabulary
 * @param {Array<{id: string, name: string}>} p.regions regions a "đặc sản" sentence may name
 * @param {Array<{id: string, names: string[]}>} [p.originRegions] regions (countries too) a "có nguồn gốc từ" sentence may name
 * @returns {Array<object>} claim proposals (without evidence)
 */
export function proposalsFromSentence({ sentence, entityKey, namesByEntity, vocabulary, regions = [], originRegions = [], canonicalNames = null }) {
  const out = proposalsFromSentenceRaw({ sentence, entityKey, namesByEntity, vocabulary, regions, originRegions });
  if (!out.length || !canonicalNames) return out;
  // the sentence's subject is the dish only when it is named by its OWN name: "Bánh khoái là một loại bánh
  // xèo …" (bánh khoái an alias of bánh xèo) speaks of the alias-named dish -> every fact is only a proposal
  const own = nameSpans(sentence, namesByEntity.get(entityKey) || []).sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const aliasSubject = own.length > 0 && !canonicalNames.has(fold(own[0][2]).folded.trim());
  return aliasSubject ? out.map((p) => ({ ...p, aliasSubject: true })) : out;
}

function proposalsFromSentenceRaw({ sentence, entityKey, namesByEntity, vocabulary, regions = [], originRegions = [] }) {
  // --- which dishes the sentence names (longest span wins: "bánh căn Phan Rang" over "bánh căn")
  const byPos = new Map(); // one span per position (accented and unaccented names match the same text)
  for (const [key, names] of namesByEntity) for (const s of nameSpans(sentence, names)) byPos.set(`${s[0]}:${s[1]}`, [...s, key]);
  const raw = [...byPos.values()];
  const spans = raw.filter((s) => !raw.some((o) => o !== s && o[0] <= s[0] && o[1] >= s[1] && o[1] - o[0] > s[1] - s[0]));
  // the sentence with dish names blanked out: words of a NAME are never a component ("chả" in "Bún chả cá")
  const masked = spans.reduce((t, [a, b]) => t.slice(0, a) + "§".repeat(b - a) + t.slice(b), sentence);
  const mentioned = new Set(spans.map((s) => s[3]));
  if (mentioned.size !== 1 || !mentioned.has(entityKey)) return [];
  const norm = ` ${normalizeName(sentence)} `;
  if (SKIP_SENTENCE.some((re) => re.test(norm))) return [];
  if (isRegional(sentence)) return [];
  // "… (được) gọi là X": fine when X is a known name of this dish (an apposition, "Bánh căn, còn gọi
  // là bánh căn Phan Rang, là …"); otherwise X is a variant or another naming ("Sủi cảo trứng")
  const ownNames = new Set((namesByEntity.get(entityKey) || []).map(normalizeName));
  for (const m of sentence.matchAll(/gọi là\s+["“']?([^,.;:()"”']+)/giu)) {
    if (!ownNames.has(normalizeName(m[1]))) return [];
  }
  const own = spans.filter((s) => s[3] === entityKey).sort((a, b) => a[0] - b[0]);
  // "xôi vò …, xôi đỗ …, xôi lạc …": a list of variants
  if (own.length >= 3) return [];
  const first = own[0];
  // "Món sườn dùng trong cơm tấm …", "nước dùng của phở …": the dish is not the subject
  const dishIsModifier = /(?:^|\s)(?:trong|của|cho|vào|như)\s+(?:món\s+)?$/iu.test(sentence.slice(0, first[0]));
  // "X là một loại <dish>": the subject is another dish
  if (/(?:là một loại|là một kiểu|là một dạng|là một biến thể của)\s*$/iu.test(sentence.slice(0, first[0]))) return [];
  // "<dish> Thanh Trì", "<dish> miền Bắc": a regional variant — not the typical dish
  for (const [, end] of own) {
    const next = sentence.slice(end).match(/^\s+(\S+)(?:\s+(\S+))?/u);
    if (next && (/^\p{Lu}/u.test(next[1]) || /^\p{Lu}/u.test(next[2] ?? "") || /^miền$/iu.test(next[1]))) return [];
  }

  const all = vocabulary.match(sentence).matches;
  const insideName = (m) => spans.some(([a, b]) => m.start < b && m.end > a);
  // "cơm cháy hải sản …", "phở gà …": the name + a food word names a VARIANT — its facts are not the dish's
  if (own.some(([, b]) => all.some((m) => !insideName(m) && m.start >= b && /^\s+$/.test(sentence.slice(b, m.start)) && (m.concept === "ingredient" || m.concept.startsWith("facet:"))))) return [];
  // a word glued to the dish name names a variant ("phở gà", "mì hoành thánh", "lẩu nấm")
  const gluedToName = (m) => own.some(([a, b]) => /^\s+$/.test(sentence.slice(m.end, a) || "x") || /^\s+$/.test(sentence.slice(b, m.start) || "x"));
  const properNoun = (m) => m.start > 0 && /^\p{Lu}/u.test(m.text);
  // "nước mắm chua ngọt", "chả cá chiên", "gạo mềm", "rau đắng": the modifier belongs to the component
  const componentModifier = (m) => {
    if (!(m.concept === "facet:preparation" || m.concept.startsWith("texture.") || m.concept.startsWith("taste."))) return false;
    let pos = m.start;
    for (;;) {
      const before = masked.slice(0, pos);
      if (COMPONENT_NOUN.test(before)) return true;
      // an ingredient/attribute up to one word before ("hành tím khô", "chả cá chiên")
      const gapOk = (g) => /^\s*(?:[^\s§]+\s+)?$/u.test(g) && !/[,;:.]/.test(g) && !/(?:^|\s)(?:và|hoặc|hay|với|cùng|mà)\s*$/iu.test(g);
      const prev = all.filter((x) => x.end <= pos && !insideName(x) && gapOk(masked.slice(x.end, pos))).sort((x, y) => y.end - x.end)[0];
      if (!prev) return false;
      if (prev.concept === "ingredient") return true;
      if (!(prev.concept.startsWith("taste.") || prev.concept.startsWith("texture.") || prev.concept === "facet:preparation")) return false;
      pos = prev.start;
    }
  };
  // "không quá dẻo" is not "không dẻo"; "không để nóng quá hoặc nguội quá": a negation a few
  // words back makes the meaning uncertain — skipped rather than guessed
  const notTooX = (m) =>
    (m.negated && /không quá\s*$/iu.test(sentence.slice(0, m.start))) ||
    (!m.negated && /(?:^|\s)(?:không|chẳng|đừng)\s+(?:\S+\s+){0,6}$/iu.test(sentence.slice(0, m.start).split(/[,;:]/).pop()));

  // Which part of the sentence speaks about the dish: from its name onward
  // (appositions like "Bánh căn, còn gọi là …, là món …" keep the subject)
  // until a clause turns to something else; text in brackets never counts.
  const cuts = [0, ...[...sentence.matchAll(/[,;:]/g)].map((m) => m.index + 1), sentence.length + 1];
  const clauseOf = (pos) => cuts.findIndex((c, i) => pos >= c && pos < cuts[i + 1]);
  const brackets = [...sentence.matchAll(/\([^)]*\)|\[[^\]]*\]/g)].map((m) => [m.index, m.index + m[0].length]);
  const inBrackets = (pos) => brackets.some(([a, b]) => pos >= a && pos < b);
  const firstClause = clauseOf(first[0]);
  // ("còn gọi là …" is an apposition, not "còn" = "whereas")
  const TOPIC_CHANGE = /^(?:ma|nhung|con(?! (?:goi|duoc goi|co ten|duoc biet))|trong khi|khac voi|tuy nhien|song|nguoc lai|ngoai ra)\b/;
  let lastClause = firstClause;
  for (let k = firstClause + 1; k < cuts.length - 1; k++) {
    if (TOPIC_CHANGE.test(normalizeName(sentence.slice(cuts[k], cuts[k + 1] - 1)))) break;
    lastClause = k;
  }
  // "…, nhưng …" / "… trong khi …" inside a clause also turns away from the dish
  const turn = sentence.slice(first[1]).match(/\s(?:nhưng|trong khi|tuy nhiên|ngược lại|song)\s/u);
  const stopAt = turn ? first[1] + turn.index : Infinity;
  const aboutDish = (m) => m.start >= first[1] && m.start < stopAt && clauseOf(m.start) <= lastClause && !inBrackets(m.start);
  // Everything after "ăn kèm / chấm / dọn cùng …" is an accompaniment ("Ăn kèm phở là …": all of it).
  const servedWithBefore = SERVED_WITH.test(sentence.slice(0, first[0]).split(/[,;:]/).pop());
  const servedWith = sentence.slice(first[1]).match(SERVED_WITH);
  const servedWithFrom = servedWithBefore ? first[1] : servedWith ? first[1] + servedWith.index : Infinity;
  // "ít ăn trưa", "hiếm khi …": a facet stated as rare is not a fact about the dish
  const rarely = (m) => /(?:^|\s)(?:ít|hiếm khi|không mấy|chẳng mấy)\s+(?:\S+\s+)?$/iu.test(sentence.slice(Math.max(0, m.start - 20), m.start));

  const out = [];
  const seen = new Set();
  const push = (p) => {
    const k = JSON.stringify([p.kind, p.key, p.value, p.level]);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(p);
    }
  };
  for (const m of all) {
    if (m.ambiguous || insideName(m) || properNoun(m) || !aboutDish(m) || notTooX(m)) continue;
    if (m.concept !== "temperature.serving" && gluedToName(m)) continue;
    if (m.start >= servedWithFrom) {
      // an accompaniment is recorded as such; its taste/texture is not the dish's
      if (m.concept === "ingredient" && !m.negated) push({ kind: "ingredient", key: m.value, value: "served_with" });
      continue;
    }
    if (componentModifier(m)) continue;
    if (dishIsModifier && m.concept !== "ingredient") continue;
    if (m.concept.startsWith("facet:") && rarely(m)) continue;
    if (m.concept === "temperature.serving") {
      if (!m.negated) push({ kind: "attribute", key: m.concept, value: m.value });
    } else if (m.concept.startsWith("taste.") || m.concept.startsWith("texture.")) {
      push({ kind: "attribute", key: m.concept, level: m.negated ? "none" : m.level ?? "medium" });
    } else if (m.concept.startsWith("facet:")) {
      const facet = m.concept.slice(6);
      if (DISH_LEVEL_FACETS.has(facet) && !m.negated) push({ kind: "facet", key: facet, value: m.value });
    } else if (m.concept === "ingredient" && !m.negated) {
      push({ kind: "ingredient", key: m.value, value: "unspecified" });
    }
  }
  // "X là đặc sản của …": only when the dish itself is the subject ("Bánh tráng xoài là …" is another dish)
  const subjectIsDish = /^\s*(?:,|là|được|vốn là|chính là|\(|còn)/iu.test(sentence.slice(first[1]));
  if (norm.includes(" dac san ") && subjectIsDish) {
    for (const r of regions) if (norm.includes(` ${normalizeName(r.name)} `)) push({ kind: "relation", key: "regional_specialty", value: r.id });
  }
  // "Phở có nguồn gốc từ Nam Định": where the DISH comes from (never where a merchant is) — the
  // region must follow the phrase directly; a one/two-letter name ("Ý") is too ambiguous in prose
  const origin = sentence.slice(first[1], stopAt).match(ORIGIN);
  const originSubject = subjectIsDish || /^\s*(?:có|vốn|được cho là|bắt nguồn|xuất xứ|khởi nguồn|du nhập)(?![\p{L}])/iu.test(sentence.slice(first[1]));
  if (origin && originSubject) {
    const after = normalizeName(sentence.slice(first[1] + origin.index + origin[0].length).split(/[,;:.()]/)[0]);
    for (const r of originRegions) {
      if (r.names.some((n) => normalizeName(n).length >= 3 && ` ${after} `.startsWith(` ${normalizeName(n)} `))) push({ kind: "relation", key: "origin_region", value: r.id, hedged: HEDGED.test(sentence) });
    }
  }
  return out;
}


// "<dish> (…) là (một) món / loại / kiểu / biến thể của <other known dish> …": the source says it is a variant
const VARIANT_OF = /^\s*(?:\([^)]*\)\s*)?(?:,\s*(?:còn|hay) (?:được )?gọi là[^,]*,\s*)?là\s+(?:một\s+)?(?:món|loại|kiểu|dạng|biến thể của|phiên bản của|biến tấu của|món ăn biến tấu từ)\s+/iu;

/**
 * variant_of proposals from a sentence that OPENS with the dish's own name and defines it as a
 * kind of another known dish. Only the longest other-dish name directly after the phrase counts.
 */
const NOT_A_VARIANT_TARGET = /^(?:món\s+)?(?:tráng miệng|ăn vặt|ăn nhẹ|khai vị|đồ uống|thức uống|đồ ngọt|món chính|món phụ|thức ăn)$/iu;

export function variantProposals({ sentence, entityKey, namesByEntity }) {
  const own = (namesByEntity.get(entityKey) || []).map((n) => fold(n).folded).filter(Boolean).sort((a, b) => b.length - a.length);
  const { folded } = fold(sentence);
  const opening = own.find((n) => folded.startsWith(n) && !/[\p{L}\p{N}]/u.test(folded[n.length] ?? ""));
  if (!opening) return [];
  const rest = sentence.slice(opening.length);
  const m = rest.match(VARIANT_OF);
  if (!m) return [];
  // accent-SENSITIVE ("bánh phổ biến" is not "bánh phở"); unaccented names only against unaccented text
  const afterText = rest.slice(m[0].length);
  const { original: afterLower, folded: afterFolded } = fold(afterText);
  let best = null;
  for (const [key, names] of namesByEntity) {
    if (key === entityKey) continue;
    for (const name of names) {
      const f = fold(name);
      const accented = f.original.trim() !== f.folded.trim();
      // an unaccented search form of an accented dish ("pho" for Phở) never names it here ("pho mát" is cheese)
      if (!accented && name !== names[0]) continue;
      const n = (accented ? f.original : f.folded).trim();
      const hay = accented ? afterLower : afterFolded;
      if (!n || !hay.startsWith(n) || /[\p{L}\p{N}]/u.test(hay[n.length] ?? "")) continue;
      if (!accented && afterLower.slice(0, n.length) !== n) continue;
      // a course / category ("món tráng miệng", "đồ uống") is not a dish something is a variant of
      if (NOT_A_VARIANT_TARGET.test(names[0] ?? name)) continue;
      if (!best || n.length > best.len) best = { key, len: n.length };
    }
  }
  return best ? [{ kind: "relation", key: "variant_of", value: best.key }] : [];
}

const ALIAS_RE =/(?:còn (?:được )?gọi là|hay (?:còn )?(?:được )?gọi là|còn có tên(?: gọi)? là|hay còn gọi)\s+([^.;:()\[\]]+)/iu;

/** Alternative names stated in a sentence ("… còn gọi là X hay Y"). */
export function aliasesFromSentence(sentence) {
  const m = sentence.match(ALIAS_RE);
  if (!m) return [];
  // the names end where the sentence goes on ("…, là món bánh", "… được làm từ")
  const names = m[1].split(/\s*,?\s+(?:là|được|thường|có|và|vì|nhưng)\s+/u)[0];
  return names
    .split(/\s*(?:,|\bhay\b|\bhoặc\b)\s*/u)
    .map((s) => s.replace(/["“”'‘’]/g, "").trim())
    .filter((s) => s && s.split(/\s+/).length <= 5 && /\p{L}/u.test(s));
}
