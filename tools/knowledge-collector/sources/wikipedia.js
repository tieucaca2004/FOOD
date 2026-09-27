import { htmlToText, normalizeName, fold } from "../../../platform/knowledge/text.js";
import { splitSentences, proposalsFromSentence, aliasesFromSentence, variantProposals } from "../extract/foodFacts.js";

// Vietnamese Wikipedia articles (/wiki/<title>, allowed by robots.txt;
// CC BY-SA 4.0) as evidence for food entities. Only /wiki/ pages are
// fetched — never /w/ or /api/ (disallowed for crawlers).

export function articleUrl(base, title) {
  return `${base}${encodeURIComponent(title.replace(/ /g, "_"))}`;
}

/** Title + paragraph texts of an article; null for a non-article (disambiguation…). */
export function parseArticle(html) {
  const h1 = html.match(/<h1[^>]*id="firstHeading"[^>]*>([\s\S]*?)<\/h1>/i);
  const title = h1 ? htmlToText(h1[1]) : null;
  if (!title) return null;
  if (/id="disambigbox"|class="[^"]*dmbox|trang định hướng/i.test(html)) return null;
  const start = html.indexOf('id="mw-content-text"');
  const body = start >= 0 ? html.slice(start) : html;
  const paragraphs = [...body.matchAll(/<p(?:\s[^>]*)?>([\s\S]*?)<\/p>/gi)].map((m) => htmlToText(m[1])).filter((t) => t.length > 0);
  return { title, paragraphs };
}

export function entityKeyFor(title) {
  return normalizeName(title).replace(/ /g, "-");
}

// The opening of an article about a dish or drink says so. A title that
// redirects elsewhere ("Sinh tố" -> "Vitamin") does not become a food.
const FOOD_SIGNAL = /\b(?:mon|mon an|do uong|thuc uong|nuoc giai khat|am thuc|dac san|mon banh|loai banh|loai cha|mon an vat|mon trang mieng|nguyen lieu|duoc lam tu|lam tu bot|nhan banh)\b/;

/**
 * Member article titles (and sub-category names) of a Wikipedia category page.
 * Only what the page lists; its "next page" link lives under /w/ (robots-disallowed) and is not followed.
 */
export function categoryMembers(html) {
  const section = (id) => {
    const at = html.indexOf(`id="${id}"`);
    if (at < 0) return "";
    const end = html.indexOf('<div class="printfooter"', at);
    return html.slice(at, end > at ? end : undefined);
  };
  const titles = (chunk) => [...chunk.matchAll(/<a href="\/wiki\/[^"]+" title="([^"]+)"/g)].map((m) => htmlToText(m[1]));
  const subcats = titles(section("mw-subcategories").split('id="mw-pages"')[0]).filter((t) => t.startsWith("Thể loại:")).map((t) => t.slice("Thể loại:".length));
  const pages = titles(section("mw-pages")).filter((t) => !t.includes(":"));
  return { pages: [...new Set(pages)], subcategories: [...new Set(subcats)] };
}

/** Titles of the configured categories ({name, depth}), sub-categories followed `depth` levels. */
export async function categoryTitles({ fetcher, base, categories, exclude = [], log = () => {} }) {
  const skip = new Set(exclude.map(normalizeName));
  const out = new Set();
  const visited = new Set();
  const queue = categories.map((c) => (typeof c === "string" ? { name: c, depth: 0 } : { depth: 0, ...c }));
  while (queue.length) {
    const { name, depth } = queue.shift();
    if (visited.has(name) || skip.has(normalizeName(name)) || NON_DISH_CATEGORY.test(name)) continue;
    visited.add(name);
    let page;
    try {
      page = await fetcher.fetch(articleUrl(base, `Thể loại:${name}`), { sourceType: "encyclopedia" });
    } catch (err) {
      log(`category ${name}: FAILED ${err.message}`);
      continue;
    }
    if (!page.ok) continue;
    const m = categoryMembers(page.content);
    for (const t of m.pages) out.add(t);
    log(`category ${name}: ${m.pages.length} pages, ${m.subcategories.length} sub-categories`);
    if (depth > 0) for (const s of m.subcategories) queue.push({ name: s, depth: depth - 1 });
  }
  return [...out];
}

// sub-categories of people, places, businesses, plants/animals, spices, media — not dishes
const NON_DISH_CATEGORY = /^(?:nhà hàng|quán|rau|cây|thực vật|động vật|loài|đầu bếp|người|nhân vật|công ty|doanh nghiệp|thương hiệu|chuỗi|sách|phim|chương trình|trò chơi|gia vị|nông sản|trái cây|quả|hạt|nấm|lễ hội|hội chợ|tổ chức|giải thưởng|dụng cụ|đồ dùng|kỹ thuật)(?![\p{L}])/iu;
// "X là một nhà hàng / loài cá / loại rau / đầu bếp / công ty …": the article is not about a dish or drink
const NOT_FOOD_SUBJECT = /\blà\s+(?:một\s+)?(?:(?:nhà hàng|chuỗi nhà hàng|chuỗi|quán|công ty|thương hiệu|tập đoàn|đầu bếp|nhà văn|diễn viên|ca sĩ|chính trị gia|thành phố|tỉnh|huyện|làng|ngôi làng|lễ hội|bộ phim|cuốn sách|chương trình|trò chơi|loài|chi|họ|giống|phân loài|cây|loại cây|loại rau|loài cây|loại củ|loại quả|loại nấm|loại hạt|dụng cụ|kỹ thuật|phương pháp|loại than|enzym|chất|hợp chất|đường phố|khu phố|con phố|cụm từ|phong cách|tên gọi chung của (?:\S+\s+){0,2}giống|giống bò|giống lợn|giống gà|loại bột|phần thịt|bộ phận)(?![\p{L}]))/iu;
// a biological taxon ("Spisula sachalinensis (Schrenck, 1862)"): a species, not a dish
const TAXON_AUTHORITY = /\(\s*\p{Lu}[\p{L}.' -]+,\s*1[6-9]\d\d\s*\)/u;
const NOT_A_DISH_TITLE = /^(?:ẩm thực|lễ hội|danh sách|văn hóa|văn hoá|lịch sử|chợ|nhà hàng|thương hiệu|công ty|hội chợ|đầu bếp|ăn độn|ăn chay)(?![\p{L}])/iu;

/** The defining sentence says the subject is not a dish or drink (a restaurant, a species, charcoal, a phrase…). */
export function isNotADish(namingSentence) {
  if (TAXON_AUTHORITY.test(namingSentence)) return true;
  const isAt = namingSentence.search(/(?:^|\s)là\s/u);
  return isAt >= 0 && NOT_FOOD_SUBJECT.test(namingSentence.slice(isAt, isAt + 70));
}

export { NOT_A_DISH_TITLE };

/** The whole title is one preparation word of the vocabulary ("Nướng", "Chiên", "Hấp"). */
export function isCookingMethod(title, vocabulary) {
  const m = vocabulary.match(title).matches;
  return m.length > 0 && m.every((x) => x.concept === "facet:preparation") && normalizeName(m.map((x) => x.text).join(" ")) === normalizeName(title);
}

export function redirectedToBroader(requested, title) {
  const [r, t] = [normalizeName(requested), normalizeName(title)];
  return r !== t && ` ${r} `.includes(` ${t} `);
}

export function isFoodArticle(article) {
  const opening = article.paragraphs.slice(0, 2).flatMap(splitSentences).slice(0, 3).join(" ");
  return FOOD_SIGNAL.test(normalizeName(opening));
}

/**
 * Step 1 — the entity itself (+ stated aliases) from one article.
 * @param {string} [requestedTitle] the title asked for, when the wiki redirected
 * @returns {{key, outcome, reasons, sentences: string[]}|null}
 */
export function proposeEntityFromArticle({ knowledge, source, article, requestedTitle = null }) {
  const key = entityKeyFor(article.title);
  const sentences = article.paragraphs.flatMap(splitSentences);
  if (!isFoodArticle(article)) return { key, outcome: "skipped", reasons: [{ code: "NOT_A_FOOD_ARTICLE" }], sentences: [] };
  // "Ẩm thực Huế", "Lễ hội …", "Danh sách món …": about food, but not a dish
  if (NOT_A_DISH_TITLE.test(article.title)) return { key, outcome: "skipped", reasons: [{ code: "NOT_A_DISH_TITLE" }], sentences: [] };
  // "Nướng", "Luộc": a cooking method is not a dish ("Bánh tráng nướng" is)
  if (isCookingMethod(article.title, knowledge.vocabulary)) return { key, outcome: "skipped", reasons: [{ code: "COOKING_METHOD_NOT_A_DISH" }], sentences: [] };
  const naming = sentences.find((s) => ` ${normalizeName(s)} `.includes(` ${normalizeName(article.title)} `));
  if (!naming) return { key, outcome: "skipped", reasons: [{ code: "NO_NAMING_SENTENCE" }], sentences };
  // the defining "X là …" of the naming sentence decides what the article is about
  if (isNotADish(naming)) return { key, outcome: "skipped", reasons: [{ code: "NOT_A_DISH_SUBJECT" }], sentences: [] };
  // "Thịt nướng" -> "Nướng" (a cooking method), "Gỏi cá mai" -> "Cá mai" (a fish): a redirect to a
  // title INSIDE the asked-for name is a broader topic, not the dish
  if (requestedTitle && redirectedToBroader(requestedTitle, article.title)) return { key, outcome: "skipped", reasons: [{ code: "REDIRECTED_TO_BROADER_TOPIC" }], sentences: [] };
  // "Chả giò" redirected to "Nem rán": the asked-for name is an alias only if the article itself uses it
  if (requestedTitle && normalizeName(requestedTitle) !== normalizeName(article.title)) {
    const usesIt = sentences.find((s) => ` ${normalizeName(s)} `.includes(` ${normalizeName(requestedTitle)} `));
    if (usesIt) article.redirectAlias = { name: requestedTitle, quote: usesIt };
  }
  const existing = knowledge.entity(key);
  const result = existing
    ? { entity: existing, outcome: existing.status, reasons: [{ code: "ALREADY_EXISTS" }] }
    : knowledge.proposeEntity({ key, canonicalName: article.title, evidence: { sourceId: source.id, quote: naming, extraction: "explicit", proposedBy: "collector:wikipedia" } });
  if (article.redirectAlias && knowledge.entity(key)?.status === "published") {
    knowledge.proposeName({ entityKey: key, name: article.redirectAlias.name, kind: "alias", evidence: { sourceId: source.id, quote: article.redirectAlias.quote, extraction: "explicit", proposedBy: "collector:wikipedia-redirect" } });
  }
  for (const s of sentences.slice(0, 6)) {
    if (!` ${normalizeName(s)} `.includes(` ${normalizeName(article.title)} `)) continue;
    for (const alias of aliasesFromSentence(s)) {
      if (normalizeName(alias) === normalizeName(article.title)) continue;
      knowledge.proposeName({ entityKey: key, name: alias, kind: "alias", evidence: { sourceId: source.id, quote: s, extraction: "explicit", proposedBy: "collector:wikipedia" } });
    }
  }
  return { key, outcome: result.entity?.status ?? result.outcome, reasons: result.reasons, sentences };
}

/**
 * Step 2 — attribute/facet/ingredient/relation proposals for one entity.
 * `policy.auto_publish[kind] === false` proposes that kind as rule-derived
 * (-> the validator sends it to review), see config/extraction-policy.json.
 */
/** Folded canonical (and derived unaccented) names of an entity — not its aliases. */
export function canonicalNamesOf(knowledge, entityKey) {
  const e = knowledge.entity(entityKey);
  if (!e) return new Set();
  return new Set(knowledge.db.prepare(`SELECT name FROM kb_food_names WHERE entity_id = ? AND kind IN ('canonical', 'no_accent') AND status = 'published'`).all(e.id).map((r) => fold(r.name).folded.trim()));
}

export function proposeFactsFromSentences({ knowledge, source, entityKey, sentences, namesByEntity, regions, originRegions = [], policy = { auto_publish: {} } }) {
  const counts = { proposed: 0, published: 0, review: 0, rejected: 0 };
  if (knowledge.entity(entityKey)?.status !== "published") return counts;
  const canonicalNames = canonicalNamesOf(knowledge, entityKey);
  const found = sentences.map((sentence) => ({
    sentence,
    proposals: [...proposalsFromSentence({ sentence, entityKey, namesByEntity, vocabulary: knowledge.vocabulary, regions, originRegions, canonicalNames }), ...variantProposals({ sentence, entityKey, namesByEntity })],
  }));
  // how many different sentences state each fact: a fact stated once is only a proposal for review
  const support = new Map();
  for (const f of found) for (const p of f.proposals) {
    const k = JSON.stringify([p.kind, p.key, p.value, p.level]);
    support.set(k, (support.get(k) ?? 0) + 1);
  }
  const minSentences = policy.min_supporting_sentences ?? 1;
  for (const { sentence, proposals } of found) {
    for (const p of proposals) {
      const repeated = (support.get(JSON.stringify([p.kind, p.key, p.value, p.level])) ?? 0) >= (p.kind === "relation" ? 1 : minSentences);
      const { hedged, aliasSubject, ...claim } = p;
      const extraction = policy.auto_publish?.[p.kind] === false || !repeated || hedged || aliasSubject ? "rule" : "explicit";
      const r = knowledge.proposeClaim({ entityKey, scope: "typical", ...claim, evidence: { sourceId: source.id, quote: sentence, extraction, proposedBy: "collector:wikipedia-lexicon" } });
      counts.proposed += 1;
      counts[r.outcome] = (counts[r.outcome] ?? 0) + 1;
    }
  }
  return counts;
}
