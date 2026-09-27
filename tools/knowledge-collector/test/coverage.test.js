// Coverage expansion: name structure (families, regional style, duplicate
// candidates), origin extraction, "top quán" article extraction and the
// coverage report — over a FAKE network with made-up fixtures.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { runPilot, seedTitles } from "../pipeline.js";
import { articleUrl } from "../sources/wikipedia.js";
import { listicleSections, placeNameFromHeading, blockFields, dishMentions, dishPriceLine, isGenericPlaceName, isDishText } from "../sources/listicle.js";
import { proposalsFromSentence } from "../extract/foodFacts.js";
import { coverageReport } from "../lib/coverage.js";
import { DishFamilies, nameOverlapCandidates } from "../../../platform/knowledge/dishFamily.js";
import { FoodTaxonomy } from "../../../platform/knowledge/taxonomy.js";
import { FoodVocabulary } from "../../../platform/knowledge/vocabulary.js";
import { fakeNetwork, noWait } from "./helpers.js";

const taxonomy = new FoodTaxonomy();

// ------------------------------------------------------------------ names

test("FAMILIES: the longest head word of a name, accent-aware; a family is not an entity", () => {
  const f = new DishFamilies(taxonomy);
  assert.equal(f.familyOf("Bún bò Huế"), "bun");
  assert.equal(f.familyOf("Bánh canh chả cá"), "banh_canh");
  assert.equal(f.familyOf("Bánh căn"), "banh");
  assert.equal(f.familyOf("Bánh mì Việt Nam"), "banh_mi");
  assert.equal(f.familyOf("Hủ tiếu Nam Vang"), "hu_tieu");
  assert.equal(f.familyOf("Súp cua"), "sup");
  assert.equal(f.familyOf("Bùn"), null); // "bùn" (mud) is not "bún"
  assert.equal(f.familyOf("Pizza"), null);
});

test("STYLE: a registered region written in a dish name — after its first word, any written form", () => {
  const f = new DishFamilies(taxonomy);
  const regions = [
    { id: "vn.hue", names: ["Huế"] },
    { id: "kh.phnom-penh", names: ["Phnom Penh", "Nam Vang"] },
    { id: "vn.khanh-hoa.nha-trang", names: ["Nha Trang"] },
  ];
  assert.deepEqual(f.regionsInName("Bún bò Huế", regions).map((r) => r.regionId), ["vn.hue"]);
  assert.deepEqual(f.regionsInName("Hủ tiếu Nam Vang", regions).map((r) => r.regionId), ["kh.phnom-penh"]);
  assert.deepEqual(f.regionsInName("Nem nướng Nha Trang", regions).map((r) => r.regionId), ["vn.khanh-hoa.nha-trang"]);
  assert.deepEqual(f.regionsInName("Bún bò", regions), []);
  assert.deepEqual(f.regionsInName("Huế", regions), []); // a one-word name is not "styled"
});

test("DUPLICATES: overlapping names are candidates with a reason — never merged", () => {
  const entities = [
    { id: 1, key: "bun-bo", names: ["Bún bò"] },
    { id: 2, key: "bun-bo-hue", names: ["Bún bò Huế"] },
    { id: 3, key: "bun-cha", names: ["Bún chả"] },
    { id: 4, key: "bun-cha-ca", names: ["Bún chả cá"] },
    { id: 5, key: "nem-nuong", names: ["Nem nướng"] },
    { id: 6, key: "nem-nuong-nha-trang", names: ["Nem nướng Nha Trang"] },
    { id: 7, key: "cha-gio", names: ["Chả giò", "Nem rán"] },
    { id: 8, key: "nem-ran", names: ["Nem rán"] },
    { id: 9, key: "pho-x", names: ["Phở"] },
    { id: 10, key: "tao-pho", names: ["Tào phớ", "Phớ"] }, // "phớ" ≠ "phở": equal only without accents
  ];
  const regions = [{ id: "vn.hue", names: ["Huế"] }, { id: "vn.khanh-hoa.nha-trang", names: ["Nha Trang"] }];
  const c = Object.fromEntries(nameOverlapCandidates(entities, regions).map((x) => [`${x.a}-${x.b}`, x]));
  assert.equal(c["1-2"].kind, "regional_style_of");
  assert.equal(c["1-2"].signals.region, "vn.hue");
  assert.equal(c["5-6"].kind, "regional_style_of");
  assert.equal(c["3-4"].kind, "name_extends"); // bún chả ≠ bún chả cá: a person decides
  assert.equal(c["7-8"].kind, "shared_name");
  assert.equal(c["2-4"], undefined);
  assert.equal(c["9-10"], undefined);
});

test("ORIGIN: 'có nguồn gốc từ <region>' with the dish as subject; a short ambiguous name is ignored", () => {
  const vocabulary = new FoodVocabulary(undefined, taxonomy);
  const namesByEntity = new Map([["pho", ["Phở"]], ["mi-y", ["Mì Ý"]]]);
  const originRegions = [{ id: "vn.nam-dinh", names: ["Nam Định"] }, { id: "cn", names: ["Trung Quốc"] }, { id: "it", names: ["Ý"] }];
  const run = (sentence, entityKey = "pho") => proposalsFromSentence({ sentence, entityKey, namesByEntity, vocabulary, regions: [], originRegions }).filter((p) => p.key === "origin_region").map((p) => p.value);
  assert.deepEqual(run("Phở có nguồn gốc từ Nam Định vào đầu thế kỷ 20."), ["vn.nam-dinh"]);
  assert.deepEqual(run("Phở được cho là bắt nguồn từ tỉnh Nam Định."), ["vn.nam-dinh"]);
  assert.deepEqual(run("Nhiều người ăn phở ở Nam Định."), []); // no origin phrase
  assert.deepEqual(run("Mì Ý có nguồn gốc từ Ý.", "mi-y"), []); // "Ý" is too short to trust in prose
  // the source hedges ("được cho là", "nhiều giả thiết cho rằng") -> marked, sent to review by the collector
  const hedged = (sentence) => proposalsFromSentence({ sentence, entityKey: "pho", namesByEntity, vocabulary, regions: [], originRegions }).find((x) => x.key === "origin_region")?.hedged;
  assert.equal(hedged("Phở được cho là bắt nguồn từ tỉnh Nam Định."), true);
  assert.equal(hedged("Phở có nguồn gốc từ Nam Định vào đầu thế kỷ 20."), false);
});

// ------------------------------------------------------------------ listicle parsing

test("LISTICLE: numbered headings with an address are places; names are cut at SEO tails, not guessed", () => {
  assert.equal(placeNameFromHeading("8 Nem nướng Đặng Văn Quyên - Nhà hàng Nha Trang chuyên nem"), "Nem nướng Đặng Văn Quyên");
  assert.equal(placeNameFromHeading("2.1 Bún cá Cô Ba"), "Bún cá Cô Ba");
  assert.equal(placeNameFromHeading("4. Bún bò Kim Ngân Nha Trang đông khách bậc nhất phố biển"), "Bún bò Kim Ngân Nha Trang");
  assert.equal(placeNameFromHeading("7. Bún bò Nha Trang ngon số 35 Huỳnh Thúc Kháng"), "Bún bò Nha Trang ngon số 35 Huỳnh Thúc Kháng");
  assert.equal(placeNameFromHeading("17. Bún bò Nha Trang ở đâu ngon? Quán Huế Hà"), "Quán Huế Hà");
  assert.equal(placeNameFromHeading("13. Địa chỉ quán cháo hàu ngon Nha Trang"), null);
  assert.equal(placeNameFromHeading("3. Lưu ý khi đi ăn"), null);
  assert.equal(placeNameFromHeading("Bún cá Cô Ba"), null); // not numbered
  assert.deepEqual(blockFields("Địa chỉ: 32C Trần Phú, Nha Trang. Giờ mở cửa: 6:00 - 10:00"), [
    { label: "dia chi", value: "32C Trần Phú, Nha Trang" },
    { label: "gio mo cua", value: "6:00 - 10:00" },
  ]);
});

const LISTICLE = `<html><body><h1>Top quán bún cá Nha Trang</h1>
<h2>1 Bún cá Nha Trang, tinh hoa xứ biển</h2><p>Bún cá là món ăn sáng.</p>
<h2>2 Top quán ngon</h2>
<h3>2.1 Bún cá Cô Ba</h3><p>Địa chỉ: 105 Hoàng Hoa Thám, Lộc Thọ, Nha Trang.</p><p>Giờ mở cửa: 6h - 19h30</p><p>Giá tham khảo: 30.000 - 45.000 VNĐ/tô.</p><p>Món nổi bật: bún cá, bánh căn.</p><p>Quán không có chào hỏi rườm rà, ai cũng mê bánh xèo ở góc chợ.</p>
<h3>2.2 Quán Lẩu Dê Bảy Hòa - lẩu ngon</h3><p>Địa chỉ: 12 Nguyễn Trãi, Cam Ranh</p><p>Thực đơn: Bún cá: 35.000đ</p>
<h3>2.3 Nhà hàng chay Hoan Hỷ</h3><p>Địa chỉ: 47B Lê Đại Hành, Nha Trang</p>
<h3>2.4 Quán không địa chỉ</h3><p>Chỉ bán bún cá.</p>
<h2>Kết luận</h2><p>Trên đây là danh sách bún cá.</p>
<p>Nguồn: Tổng hợp</p><h3>Vali giảm giá</h3><p>Địa chỉ: kho hàng</p></body></html>`;

test("LISTICLE: sections, fields, accent-sensitive dish mentions and what is NOT a product price", () => {
  const s = listicleSections(LISTICLE);
  assert.deepEqual(s.map((x) => x.name), ["Bún cá Cô Ba", "Quán Lẩu Dê Bảy Hòa", "Nhà hàng chay Hoan Hỷ"]);
  assert.equal(s[0].address.text, "105 Hoàng Hoa Thám, Lộc Thọ, Nha Trang");
  assert.equal(s[0].hours.text, "6h - 19h30");
  assert.deepEqual(s[0].priceNotes.map((n) => n.value), ["30.000 - 45.000 VNĐ/tô"]);
  const foods = [{ entityKey: "bun-ca", name: "Bún cá" }, { entityKey: "chao", name: "Cháo" }, { entityKey: "banh-xeo", name: "Bánh xèo" }];
  assert.deepEqual(dishMentions("Quán không có chào hỏi, cháo ngon", foods).map((d) => d.text), ["cháo"]); // "chào" ≠ "cháo"
  assert.deepEqual(dishMentions("Quán không bán bánh xèo", foods), []); // negated
  const line = "Bún cá: 35.000đ";
  assert.equal(dishPriceLine(line, dishMentions(line, foods)[0]), "35.000đ");
  const ref = "Bún cá: giá tham khảo 30.000 - 45.000đ";
  assert.equal(dishPriceLine(ref, dishMentions(ref, foods)[0]), null);
});

// ------------------------------------------------------------------ pipeline with articles

const WIKI = "https://vi.wikipedia.org/wiki/";
const article = (title, paragraphs) => `<html><body><h1 id="firstHeading">${title}</h1><div id="mw-content-text">${paragraphs.map((p) => `<p>${p}</p>`).join("")}</div></body></html>`;

function repoWithArticles() {
  const repo = path.join(os.tmpdir(), `coverage-${randomUUID()}`);
  fs.mkdirSync(path.join(repo, "cfg"), { recursive: true });
  fs.writeFileSync(path.join(repo, "cfg/seeds.json"), JSON.stringify({ wikipedia_base: WIKI, license: "CC BY-SA 4.0", attribution: "x", groups: { bun: ["Bún cá", "Bún bò", "Bún bò Huế"], banh: ["Bánh căn", "Bánh xèo"], lau: ["Lẩu dê", "Lẩu mắm"] } }));
  fs.writeFileSync(path.join(repo, "cfg/official.json"), JSON.stringify({ merchants: [] }));
  fs.writeFileSync(
    path.join(repo, "cfg/articles.json"),
    JSON.stringify({ source_type: "blog", region_id: "vn.khanh-hoa.nha-trang", other_localities: ["Cam Ranh"], articles: [{ url: "https://blog-a.example/top-bun-ca" }, { url: "https://blog-b.example/top" }, { url: "https://blocked.example/top" }] })
  );
  return repo;
}

function articleNetwork() {
  return fakeNetwork({
    "https://vi.wikipedia.org/robots.txt": { body: "User-agent: *\nDisallow: /w/" },
    [articleUrl(WIKI, "Bún cá")]: { body: article("Bún cá", ["Bún cá là món ăn sáng phổ biến ở miền Trung."]) },
    [articleUrl(WIKI, "Bún bò")]: { body: article("Bún bò", ["Bún bò là món ăn làm từ bún và thịt bò."]) },
    [articleUrl(WIKI, "Bún bò Huế")]: { body: article("Bún bò Huế", ["Bún bò Huế là món ăn đặc trưng của Huế, có nguồn gốc từ Huế."]) },
    [articleUrl(WIKI, "Bánh căn")]: { body: article("Bánh căn", ["Bánh căn là món bánh làm từ bột gạo."]) },
    "https://blog-a.example/robots.txt": { status: 404, body: "" },
    "https://blog-a.example/top-bun-ca": { body: LISTICLE },
    "https://blog-b.example/robots.txt": { status: 404, body: "" },
    "https://blog-b.example/top": { body: `<h2>1. Bún cá Cô Ba - quán lâu đời</h2><p>Địa chỉ: 105 Hoàng Hoa Thám, Nha Trang</p><p>Bún cá ở đây có sứa.</p>` },
    "https://blocked.example/robots.txt": { body: "User-agent: *\nDisallow: /" },
  });
}

test("ARTICLES: places, addresses, hours and dish mentions with evidence; nothing merged or invented", async () => {
  const repo = repoWithArticles();
  const dbPath = path.join(repo, "data/kb.db");
  const net = articleNetwork();
  const { summary } = await runPilot({ repoRoot: repo, dbPath, rawRoot: path.join(repo, "data/raw"), fetchImpl: net.fetchImpl, wait: noWait, minIntervalMs: 0, seedsFile: path.join(repo, "cfg/seeds.json"), officialFile: path.join(repo, "cfg/official.json"), articlesFile: path.join(repo, "cfg/articles.json"), skipOsm: true, search: { configured: false } });
  assert.equal(summary.articles.pages, 2);
  assert.deepEqual(summary.articles.blocked.map((b) => b.reason), ["robots"]);
  const db = new Database(dbPath, { readonly: true });
  const q = (sql, ...a) => db.prepare(sql).all(...a);

  // the same name at the same address in two articles: two candidates + a same-address duplicate candidate, NOT merged
  const coBa = q(`SELECT id FROM kb_merchants WHERE name = 'Bún cá Cô Ba'`);
  assert.equal(coBa.length, 2);
  const dup = q(`SELECT * FROM kb_duplicate_candidates`)[0];
  assert.equal(JSON.parse(dup.signals_json).same_address, true);
  assert.equal(dup.score, 0.8);
  assert.equal(dup.status, "pending");

  // address verbatim, region only when the address does not name another locality
  const locs = Object.fromEntries(q(`SELECT m.name, l.address_original, l.region_id FROM kb_merchant_locations l JOIN kb_merchants m ON m.id = l.merchant_id`).map((r) => [`${r.name}|${r.address_original}`, r.region_id]));
  assert.equal(locs["Bún cá Cô Ba|105 Hoàng Hoa Thám, Lộc Thọ, Nha Trang"], "vn.khanh-hoa.nha-trang");
  assert.equal(locs["Quán Lẩu Dê Bảy Hòa|12 Nguyễn Trãi, Cam Ranh"], null);
  assert.equal(q(`SELECT original_text FROM kb_merchant_claims WHERE field = 'opening_hours'`)[0].original_text, "6h - 19h30");

  // cuisine only as the heading says it
  assert.deepEqual(q(`SELECT m.name, c.value_json, c.original_text FROM kb_merchant_claims c JOIN kb_merchants m ON m.id = c.merchant_id WHERE c.field = 'cuisine'`), [{ name: "Nhà hàng chay Hoan Hỷ", value_json: JSON.stringify({ facet: "dietary", key: "vegetarian" }), original_text: "chay" }]);

  // dish mentions: heading / "Món …:" line -> published mention + exact link; other body text -> review
  const products = q(`SELECT m.name AS merchant, p.original_name, p.observation, p.status FROM kb_merchant_products p JOIN kb_merchants m ON m.id = p.merchant_id ORDER BY p.id`);
  assert.ok(products.every((p) => p.observation === "mention"));
  const find = (merchant, name) => products.find((p) => p.merchant === merchant && p.original_name.toLowerCase() === name);
  assert.equal(find("Bún cá Cô Ba", "bún cá").status, "published");
  assert.equal(find("Bún cá Cô Ba", "bánh căn").status, "published"); // "Món nổi bật:" line
  // a dish only mentioned in running text: the product is a proposal for review; the seed Bánh xèo
  // (no encyclopedia article) gets its first evidence from it -> an entity in review, no link
  assert.equal(find("Bún cá Cô Ba", "bánh xèo").status, "review");
  assert.equal(q(`SELECT status FROM kb_food_entities WHERE key = 'banh-xeo'`)[0].status, "review");
  assert.equal(q(`SELECT COUNT(*) AS n FROM kb_food_product_links l JOIN kb_food_entities f ON f.id = l.food_entity_id WHERE f.key = 'banh-xeo'`)[0].n, 0);
  // "Giá tham khảo" is not a price; "Bún cá: 35.000đ" on a menu line is
  const prices = q(`SELECT p.price, pr.original_name, m.name FROM kb_product_prices p JOIN kb_merchant_products pr ON pr.id = p.product_id JOIN kb_merchants m ON m.id = pr.merchant_id`);
  assert.deepEqual(prices.map((p) => [p.name, p.price]), [["Quán Lẩu Dê Bảy Hòa", 35000]]);
  const links = q(`SELECT f.key, l.match_type, l.status FROM kb_food_product_links l JOIN kb_food_entities f ON f.id = l.food_entity_id WHERE l.status = 'published'`);
  assert.ok(links.length >= 3 && links.every((l) => l.match_type === "exact"));

  // name structure: Bún bò Huế -> regional_style Huế (review), origin Huế (published), and a candidate with Bún bò
  const rel = q(`SELECT c.key, c.value, c.status FROM kb_claims c JOIN kb_food_entities e ON e.id = c.entity_id WHERE e.key = 'bun-bo-hue' AND c.kind = 'relation'`);
  assert.deepEqual(rel.find((r) => r.key === "regional_style"), { key: "regional_style", value: "vn.hue", status: "review" });
  assert.deepEqual(rel.find((r) => r.key === "origin_region"), { key: "origin_region", value: "vn.hue", status: "published" });
  const fd = q(`SELECT d.kind, a.key AS a, b.key AS b, d.status FROM kb_food_duplicate_candidates d JOIN kb_food_entities a ON a.id = d.entity_a JOIN kb_food_entities b ON b.id = d.entity_b`);
  assert.deepEqual(fd.find((d) => d.a === "bun-bo"), { kind: "regional_style_of", a: "bun-bo", b: "bun-bo-hue", status: "pending" });
  assert.equal(q(`SELECT COUNT(*) AS n FROM kb_food_entities WHERE key IN ('bun-bo', 'bun-bo-hue') AND status = 'published'`)[0].n, 2); // both stay

  // seeds: resolved / review / unresolved per group
  assert.deepEqual(summary.seeds.lau.unresolved, ["Lẩu mắm"]); // no article, no mention: nothing created
  assert.deepEqual(summary.seeds.lau.review, ["Lẩu dê"]); // named by a place ("Quán Lẩu Dê Bảy Hòa") -> review
  assert.ok(summary.seeds.banh.review.includes("Bánh xèo"));

  // coverage report: labelled, top foods are a coverage statistic only
  const cov = coverageReport(db);
  assert.match(cov.label, /current discovered Food Knowledge coverage for Nha Trang/);
  assert.match(cov.food_merchant_links.top_foods_by_merchant_count.note, /coverage statistic only/);
  assert.equal(cov.food_merchant_links.top_foods_by_merchant_count.rows[0].key, "bun-ca");
  assert.equal(cov.merchants.candidates, 4);
  assert.equal(cov.merchants.distinct_if_same_address_candidates_confirmed, 3);
  assert.equal(cov.merchants.bridged_to_platform, 0);
  assert.equal(cov.merchants.with_rating, 0);
  db.close();
});

test("ARTICLES: re-reading the same pages is the same observation — no new merchants, products or candidates", async () => {
  const repo = repoWithArticles();
  const dbPath = path.join(repo, "data/kb.db");
  const opts = { repoRoot: repo, dbPath, rawRoot: path.join(repo, "data/raw"), wait: noWait, minIntervalMs: 0, seedsFile: path.join(repo, "cfg/seeds.json"), officialFile: path.join(repo, "cfg/official.json"), articlesFile: path.join(repo, "cfg/articles.json"), skipOsm: true, search: { configured: false } };
  const counts = () => {
    const db = new Database(dbPath, { readonly: true });
    const c = ["kb_merchants", "kb_merchant_products", "kb_merchant_locations", "kb_duplicate_candidates", "kb_food_product_links", "kb_food_duplicate_candidates"].map((t) => db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n);
    db.close();
    return c;
  };
  await runPilot({ ...opts, fetchImpl: articleNetwork().fetchImpl });
  const first = counts();
  await runPilot({ ...opts, fetchImpl: articleNetwork().fetchImpl });
  assert.deepEqual(counts(), first);
});

test("LISTICLE: generic headings are not places; photo captions are not text about the place", () => {
  const html = `<h2>1. Nhà hàng</h2><p>Địa chỉ: 32C Trần Phú</p><h2>2. Bún bò Huế ở Nha Trang</h2><p>Địa chỉ: 08 Chương Dương</p><h2>3. Quán Nhã Trang</h2><p>Địa chỉ: 5 Yersin</p><p>Bún cá thơm. Ảnh: Kem Dừa</p>`;
  const s = listicleSections(html);
  assert.deepEqual(s.map((x) => x.name), ["Bún bò Huế ở Nha Trang", "Quán Nhã Trang"]); // "Nhà hàng" names nothing: dropped while parsing…
  assert.deepEqual(s[1].blocks, ["Địa chỉ: 5 Yersin", "Bún cá thơm."]); // caption cut off
  const foods = [{ name: "Bún bò Huế" }, { name: "Bún cá" }];
  assert.deepEqual(s.filter((x) => !isGenericPlaceName(x.name, foods)).map((x) => x.name), ["Quán Nhã Trang"]); // …but only one is a place
});

test("LISTICLE: address lines and links to other articles never say what a place serves", () => {
  assert.equal(isDishText("TOP 10 địa chỉ thưởng thức hương vị bánh mì chả cá Nha Trang đầy mê hoặc"), false);
  assert.equal(isDishText("Lưu gấp 12 quán lẩu bò Nha Trang ngon “số dzách”, đông khách"), false);
  assert.equal(isDishText("Địa chỉ: số 49C Cù Lao Chàm, phường Bắc Nha Trang"), false);
  assert.equal(isDishText("22 quán vịt quay – vịt nướng Nha Trang siêu ngon cực đông khách"), false);
  assert.equal(isDishText("2 tô bún cá ở đây rất đầy đặn"), true);
  assert.equal(isDishText("Ngoài bún chả cá, quán còn có bán thêm bún riêu"), true);
});

test("QUALITY + REPORT: samples re-verify provenance; the report has menu / price / semantics / tier sections", async () => {
  const { sampleQuality } = await import("../lib/quality.js");
  const { openKnowledge } = await import("../pipeline.js");
  const repo = repoWithArticles();
  const dbPath = path.join(repo, "data/kb.db");
  await runPilot({ repoRoot: repo, dbPath, rawRoot: path.join(repo, "data/raw"), fetchImpl: articleNetwork().fetchImpl, wait: noWait, minIntervalMs: 0, seedsFile: path.join(repo, "cfg/seeds.json"), officialFile: path.join(repo, "cfg/official.json"), articlesFile: path.join(repo, "cfg/articles.json"), skipOsm: true, search: { configured: false } });
  const { db, knowledge } = openKnowledge({ dbPath, repoRoot: repo });
  const s = sampleQuality({ db, knowledge, seed: 7 });
  assert.ok(s.summary.merchants.sampled >= 3 && s.summary.merchants.provenance_rate === 1);
  assert.equal(s.summary.prices.sampled, 1);
  assert.equal(s.summary.prices.provenance_rate, 1);
  // a broken raw snapshot is caught
  const src = db.prepare(`SELECT raw_path FROM kb_sources WHERE url = 'https://blog-a.example/top-bun-ca'`).get();
  fs.appendFileSync(path.join(repo, src.raw_path), "tampered");
  const knowledge2 = openKnowledge({ dbPath, repoRoot: repo }).knowledge;
  assert.ok(sampleQuality({ db, knowledge: knowledge2, seed: 7 }).rows.merchants.some((r) => r.problems.includes("RAW_CHANGED")));
  const cov = coverageReport(db, { crawl: { requests: 1 } });
  assert.equal(cov.menu.article_reported_products > 0, true);
  assert.equal(cov.prices.observations, 1);
  assert.ok(cov.sources.by_quality_tier.tier_3 > 0 && cov.sources.by_quality_tier.tier_4 > 0);
  assert.ok("taste" in cov.semantics_detail && "origin_region" in cov.semantics_detail);
  db.close();
});

test("SEEDS: groups flatten to unique titles in order", () => {
  assert.deepEqual(seedTitles({ groups: { a: ["Phở", "Bún"], b: ["Bún", "Chè"] } }), ["Phở", "Bún", "Chè"]);
  assert.deepEqual(seedTitles({ titles: ["X"] }), ["X"]);
});
