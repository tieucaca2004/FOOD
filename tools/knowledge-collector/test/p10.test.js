// P10 collection machinery: Wikipedia categories, dish-title guards, source
// inventory, failed-source queue and crash resilience — FAKE network only.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { runPilot, failedQueue } from "../pipeline.js";
import { categoryMembers, isCookingMethod, articleUrl } from "../sources/wikipedia.js";
import { isFoodSlug, articleLinks, discoverFamily } from "../sources/inventory.js";
import { RawFetcher } from "../lib/fetcher.js";
import { FoodVocabulary } from "../../../platform/knowledge/vocabulary.js";
import { FoodTaxonomy } from "../../../platform/knowledge/taxonomy.js";
import { fakeNetwork, noWait } from "./helpers.js";

const tmp = () => {
  const d = path.join(os.tmpdir(), `p10-${randomUUID()}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
};

test("CATEGORIES: member pages and sub-categories of a category page; namespaced links are not dishes", () => {
  const html = `<div id="mw-subcategories"><a href="/wiki/Th%E1%BB%83_lo%E1%BA%A1i:B%C3%BAn" title="Thể loại:Bún">Bún</a></div>
    <div id="mw-pages"><a href="/wiki/B%C3%A1nh_c%C4%83n" title="Bánh căn">Bánh căn</a><a href="/wiki/B%C3%BAn_c%C3%A1" title="Bún cá">Bún cá</a>
    <a href="/wiki/Tr%E1%BB%A3_gi%C3%BAp:X" title="Trợ giúp:X">x</a></div><div class="printfooter">Lấy từ</div><a href="/wiki/Kh%C3%A1c" title="Khác">…</a>`;
  assert.deepEqual(categoryMembers(html), { pages: ["Bánh căn", "Bún cá"], subcategories: ["Bún"] });
});

test("NOT A DISH: a bare cooking method is not an entity; a dish named with one is", () => {
  const vocabulary = new FoodVocabulary(undefined, new FoodTaxonomy());
  assert.equal(isCookingMethod("Nướng", vocabulary), true);
  assert.equal(isCookingMethod("Bánh tráng nướng", vocabulary), false);
  assert.equal(isCookingMethod("Bánh căn", vocabulary), false);
});

test("NOT A DISH: restaurants, species, plants and people from category pages are not food entities", async () => {
  const { proposeEntityFromArticle } = await import("../sources/wikipedia.js");
  const { KnowledgeStore } = await import("../../../platform/knowledge/store.js");
  const { createKnowledgeConnection, runKnowledgeMigrations } = await import("../../../platform/knowledge/db.js");
  const db = createKnowledgeConnection(":memory:");
  runKnowledgeMigrations(db);
  const knowledge = new KnowledgeStore({ db });
  const run = (title, text) => proposeEntityFromArticle({ knowledge, source: { id: 1 }, article: { title, paragraphs: [text] } }).reasons?.[0]?.code;
  assert.equal(run("Sukiyabashi Jiro", "Sukiyabashi Jiro là một nhà hàng sushi ở Tokyo, nổi tiếng về ẩm thực."), "NOT_A_DISH_SUBJECT");
  assert.equal(run("Cá mai", "Cá mai là một loài cá biển, nguyên liệu của món gỏi cá mai."), "NOT_A_DISH_SUBJECT");
  assert.equal(run("Ẩm thực Huế", "Ẩm thực Huế là các món ăn của Huế."), "NOT_A_DISH_TITLE");
  assert.notEqual(run("Kim chi", "Kim chi là một món ăn lên men, làm từ cải thảo, một loại rau."), "NOT_A_DISH_SUBJECT");
  // real misses from the category walk
  const { isNotADish } = await import("../sources/wikipedia.js");
  assert.equal(isNotADish("Than trắng hay Binchō-tan (備長炭) là một loại than truyền thống của người Nhật."), true);
  assert.equal(isNotADish("Nattokinase là một enzym (EC 3.4.21.62) được chiết xuất từ một món ăn Nhật Bản gọi là nattō."), true);
  assert.equal(isNotADish("Khu phố ăn uống hay khu phố ẩm thực là một đường phố mà được đặc biệt dành riêng để phục vụ ăn uống."), true);
  assert.equal(isNotADish("Spisula sachalinensis (Schrenck, 1862)."), true);
  assert.equal(isNotADish("Bò Nhật Bản hay còn gọi là Wagyu (和牛) là tên gọi chung của bốn giống bò thịt đặc sản của Nhật Bản."), true);
  assert.equal(isNotADish("Dashi là một phiên bản nước dùng dùng trong ẩm thực Nhật Bản."), false);
  assert.equal(isNotADish('Cà ri (từ tiếng Tamil là "kari"), là một thuật ngữ tổng quát trong tiếng Anh chỉ các món hầm.'), false); // a real dish family
  assert.equal(isNotADish("Huyết heo là một món ăn phổ biến trong nền ẩm thực Trung Hoa và Việt Nam."), false);
  db.close();
});

test("INVENTORY: food slugs kept, how-to / travel slugs dropped; listing pages walked until nothing new", async () => {
  assert.equal(isFoodSlug("https://vinwonders.com/vi/wonderpedia/news/toplist-25-quan-oc-nha-trang/"), true);
  assert.equal(isFoodSlug("https://mia.vn/cam-nang-du-lich/pizza-4p-s-nha-trang-20061"), true);
  assert.equal(isFoodSlug("https://vinwonders.com/vi/wonderpedia/news/cach-nau-bun-ca-nha-trang/"), false);
  assert.equal(isFoodSlug("https://vinwonders.com/vi/wonderpedia/news/thap-tram-huong-nha-trang/"), false);
  assert.deepEqual(articleLinks('<a href="/n/a/">a</a><a href="https://x.example/n/b/#c">b</a><a href="/other">o</a>', "https://x.example/list", "^https://x\\.example/n/[^/]+/$"), ["https://x.example/n/a/", "https://x.example/n/b/"]);
  // <base href> decides how relative links resolve
  assert.deepEqual(articleLinks('<base href="https://m.example"><a href="cam-nang/quan-a-12">a</a>', "https://m.example/cam-nang/nha-trang/an-gi?page=1", "^https://m\\.example/cam-nang/[a-z0-9-]+$"), ["https://m.example/cam-nang/quan-a-12"]);
  const page = (links) => ({ body: links.map((l) => `<a href="/n/${l}/">${l}</a>`).join("") });
  const net = fakeNetwork({
    "https://x.example/robots.txt": { status: 404, body: "" },
    "https://x.example/list/1": page(["quan-bun-ca", "thap-ba"]),
    "https://x.example/list/2": page(["quan-bun-ca", "banh-can-ngon"]),
    "https://x.example/list/3": page(["banh-can-ngon"]),
    "https://x.example/list/4": page(["banh-can-ngon"]),
    "https://x.example/list/5": page(["never-reached"]),
  });
  const fetcher = new RawFetcher({ rawRoot: path.join(tmp(), "raw"), repoRoot: tmp(), fetchImpl: net.fetchImpl, wait: noWait });
  const r = await discoverFamily({ fetcher, family: { id: "x", source_type: "blog", listing: { url_template: "https://x.example/list/{n}", from: 1, to: 9, stop_after_empty: 2 }, article_pattern: "^https://x\\.example/n/[^/]+/$" } });
  assert.deepEqual(r.articles.map((a) => [a.url, a.food]), [
    ["https://x.example/n/quan-bun-ca/", true],
    ["https://x.example/n/thap-ba/", false],
    ["https://x.example/n/banh-can-ngon/", true],
  ]);
  assert.ok(!net.calls.some((c) => c.url.endsWith("/list/5"))); // stopped after 2 pages with nothing new
});

test("PRODUCT PRICES: only '<dish-named product> <one price>' lines; ranges, per-person, nameless or ambiguous lines give nothing", async () => {
  const { productPriceSegments } = await import("../sources/listicle.js");
  const foods = ["Bánh mì", "Bún chả cá", "Bún riêu", "Bún cá", "Bánh canh", "Xíu mại", "Bún bò"];
  const seg = (v) => productPriceSegments(v, foods).map((s) => [s.name, s.priceText, s.unit]);
  assert.deepEqual(seg("Bún chả cá tô nhỏ 15.000 VND, bún cá chả đặc biệt 35.000 VND"), [["Bún chả cá tô nhỏ", "15.000 VND", null], ["bún cá chả đặc biệt", "35.000 VND", null]]);
  assert.deepEqual(seg("Bún bò lớn 40.000VND/ tô"), [["Bún bò lớn", "40.000VND", "tô"]]); // verbatim price text
  assert.deepEqual(seg("Bún riêu nhỏ 25.000 VND/ tô, tô thường 30.000 VND/ tô"), [["Bún riêu nhỏ", "25.000 VND", "tô"]]); // "tô thường" names no dish
  assert.deepEqual(seg("Bánh mì gà 17.000 VND/ chiếc, bánh mì thịt, xíu mại 18.000 VND/ chiếc"), []); // a part without its own price
  assert.deepEqual(seg("25.000 – 45.000 VNĐ/tô"), []);
  assert.deepEqual(seg("200,000 - 300,000 VNĐ/người"), []);
  assert.deepEqual(seg("Từ 25,000 VNĐ/món"), []);
  assert.deepEqual(seg("5.000 VND/ cái"), []);
});

test("AUDIT: non-dish entities, generic merchants and link-evidenced products are marked (never deleted); pairs only reported", async () => {
  const { auditKnowledge } = await import("../lib/audit.js");
  const { KnowledgeStore } = await import("../../../platform/knowledge/store.js");
  const { MerchantDiscoveryStore } = await import("../../../platform/knowledge/discoveryStore.js");
  const { createKnowledgeConnection, runKnowledgeMigrations } = await import("../../../platform/knowledge/db.js");
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "w.txt"), "Than trắng là một loại than truyền thống của người Nhật. Bánh căn là món bánh.", "utf8");
  fs.writeFileSync(path.join(dir, "b.txt"), "1. Nhà hàng Nha Trang. 2. Bún cá Cô Ba. TOP 10 địa chỉ bánh căn Nha Trang ngon.", "utf8");
  const db = createKnowledgeConnection(":memory:");
  runKnowledgeMigrations(db);
  const knowledge = new KnowledgeStore({ db, rawRoot: dir });
  const discovery = new MerchantDiscoveryStore({ knowledge });
  const w = knowledge.registerSource({ url: "https://vi.wikipedia.org/wiki/x", sourceType: "encyclopedia", rawPath: "w.txt", contentType: "text/plain", fetchedAt: "2026-09-26T00:00:00Z" });
  const b = knowledge.registerSource({ url: "https://blog.example/top", sourceType: "blog", rawPath: "b.txt", contentType: "text/plain", fetchedAt: "2026-09-26T00:00:00Z" });
  knowledge.proposeEntity({ key: "than-trang", canonicalName: "Than trắng", evidence: { sourceId: w.id, quote: "Than trắng là một loại than truyền thống của người Nhật.", extraction: "explicit" } });
  knowledge.proposeEntity({ key: "banh-can", canonicalName: "Bánh căn", evidence: { sourceId: w.id, quote: "Bánh căn là món bánh.", extraction: "explicit" } });
  const seen = "2026-09-26T00:00:00Z";
  const generic = discovery.upsertMerchant({ name: "Nhà hàng Nha Trang", identifiers: [], seenAt: seen, evidence: { sourceId: b.id, quote: "1. Nhà hàng Nha Trang.", extraction: "explicit" } });
  const real = discovery.upsertMerchant({ name: "Bún cá Cô Ba", identifiers: [], seenAt: seen, evidence: { sourceId: b.id, quote: "2. Bún cá Cô Ba.", extraction: "explicit" } });
  const linkProduct = discovery.proposeProduct({ merchantId: real.merchantId, originalName: "bánh căn", observation: "mention", evidence: { sourceId: b.id, quote: "TOP 10 địa chỉ bánh căn Nha Trang ngon.", extraction: "explicit" }, seenAt: seen });
  const before = auditKnowledge({ db, knowledge, fix: false });
  assert.deepEqual([before.checks.NOT_A_DISH_ENTITY.count, before.checks.GENERIC_MERCHANT_NAME.count, before.checks.PRODUCT_FROM_ADDRESS_OR_LINK.count], [1, 1, 1]);
  assert.equal(db.prepare(`SELECT status FROM kb_food_entities WHERE key = 'than-trang'`).get().status, "published"); // dry run changes nothing
  auditKnowledge({ db, knowledge, fix: true });
  assert.equal(db.prepare(`SELECT status FROM kb_food_entities WHERE key = 'than-trang'`).get().status, "rejected");
  assert.equal(db.prepare(`SELECT status FROM kb_food_entities WHERE key = 'banh-can'`).get().status, "published");
  assert.equal(db.prepare(`SELECT status FROM kb_merchants WHERE id = ?`).get(generic.merchantId).status, "rejected");
  assert.equal(db.prepare(`SELECT status FROM kb_merchants WHERE id = ?`).get(real.merchantId).status, "candidate");
  assert.equal(db.prepare(`SELECT status FROM kb_merchant_products WHERE id = ?`).get(linkProduct.productId).status, "rejected");
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM kb_merchants`).get().n, 2); // nothing deleted
  db.close();
});

test("VARIANTS: 'X là món / loại / biến thể của Y' (X opening the sentence, Y a known dish) -> variant_of; nothing else", async () => {
  const { variantProposals } = await import("../extract/foodFacts.js");
  const names = new Map([["hu-tieu", ["Hủ tiếu"]], ["hu-tieu-nam-vang", ["Hủ tiếu Nam Vang"]], ["banh-can", ["Bánh căn"]], ["bun-cha", ["Bún chả"]], ["bun-cha-ca", ["Bún chả cá"]]]);
  const v = (sentence, entityKey) => variantProposals({ sentence, entityKey, namesByEntity: names }).map((p) => p.value);
  assert.deepEqual(v("Hủ tiếu Nam Vang là món hủ tiếu do người Khmer chế biến.", "hu-tieu-nam-vang"), ["hu-tieu"]);
  assert.deepEqual(v("Bún chả cá là một biến thể của bún chả.", "bun-cha-ca"), ["bun-cha"]);
  assert.deepEqual(v("Bún chả cá là món bún nổi tiếng.", "bun-cha-ca"), []); // "bún" is a family word, not a dish
  assert.deepEqual(v("Người ta nói hủ tiếu Nam Vang là món hủ tiếu.", "hu-tieu-nam-vang"), []); // the dish must open the sentence
  assert.deepEqual(v("Hủ tiếu Nam Vang khác với hủ tiếu thường.", "hu-tieu-nam-vang"), []);
});

test("HTML ENTITIES: Latin-1 letters written as named entities read as the letters (case kept)", async () => {
  const { htmlToText, htmlBlocks } = await import("../../../platform/knowledge/text.js");
  assert.equal(htmlToText("<p>Nh&agrave; H&agrave;ng &ndash; Th&aacute;i Th&ocirc;ng &Aacute;</p>"), "Nhà Hàng – Thái Thông Á");
  assert.deepEqual(htmlBlocks("<h2>1. Nh&agrave; H&agrave;ng Biển</h2>").map((b) => b.text), ["1. Nhà Hàng Biển"]);
});

test("NON-FOOD PLACES: an attraction listed with an address is not a merchant; group headings are not places", async () => {
  const { isFoodPlaceSection, placeNameFromHeading, isGenericPlaceName } = await import("../sources/listicle.js");
  assert.equal(isFoodPlaceSection({ heading: "5. Tháp Bà Ponagar", blocks: ["Địa chỉ: 61 Hai Tháng Tư", "Công trình kiến trúc Chăm cổ."] }), false);
  assert.equal(isFoodPlaceSection({ heading: "2. Bún cá Cô Ba", blocks: ["Địa chỉ: 105 Hoàng Hoa Thám"] }), true);
  assert.equal(isFoodPlaceSection({ heading: "3. Costa Seafood", blocks: ["Address: 32C Tran Phu"] }), true);
  assert.equal(isFoodPlaceSection({ name: "Bãi Dài", heading: "7. Bãi Dài", blocks: ["Địa chỉ: Cam Lâm", "Có nhiều quán hải sản tươi ngon."] }), false);
  assert.equal(isFoodPlaceSection({ name: "Quán Hòn Chồng", heading: "7. Quán Hòn Chồng", blocks: ["Địa chỉ: 1 Hòn Chồng"] }), true);
  assert.equal(isFoodPlaceSection({ name: "Hòn Chồng Cafe", heading: "3. Hòn Chồng Cafe", blocks: ["Địa chỉ: 1 Hòn Chồng"] }), true);
  assert.equal(placeNameFromHeading("2. Restaurants in Vinpearl Beachfront Nha Trang"), null);
  assert.equal(placeNameFromHeading("9. MIX Greek Restaurant in Nha Trang"), "MIX Greek Restaurant in Nha Trang");
  assert.equal(isGenericPlaceName("MIX Greek Restaurant in Nha Trang", []), false);
});

test("PLACE NAMES (sample errors): the name after a descriptor; capitalised name words are not SEO tails; karaoke is not a food place", async () => {
  const { placeNameFromHeading, isFoodPlaceSection } = await import("../sources/listicle.js");
  const cases = {
    "13. Nhà hàng Nhật ở Nha Trang nổi tiếng – Hanami": "Hanami",
    "2.18 Địa điểm ăn đêm ở Nha Trang cực hot – Ốc Quyên Sài Gòn": "Ốc Quyên Sài Gòn",
    "14. Quán Hải Sản Bình Dân Nhà Tôi – quán hải sản bờ kè Nha Trang ngon rẻ": "Quán Hải Sản Bình Dân Nhà Tôi",
    "5. Sailing Club Nha Trang nhạc siêu chất": "Sailing Club Nha Trang",
    "1.2. Đồ ăn sáng Nha Trang – Bún cá Hạnh Nhiên": "Bún cá Hạnh Nhiên",
    "1. Nhà hàng Nha Trang": null,
  };
  for (const [h, want] of Object.entries(cases)) assert.equal(placeNameFromHeading(h), want, h);
  assert.equal(isFoodPlaceSection({ name: "Angel Karaoke & Rooftop Lounge Nha Trang", heading: "5. Angel Karaoke & Rooftop Lounge Nha Trang", blocks: ["Đồ uống và món ăn nhẹ"] }), false);
  assert.equal(isFoodPlaceSection({ name: "Bò né Hùng Vương khách sạn Potique", heading: "3. Bò né Hùng Vương khách sạn Potique", blocks: ["Địa chỉ: 1 Hùng Vương"] }, [{ entityKey: "bo-ne", name: "Bò né" }]), true);
});

test("COMPONENTS: a dish name right after another dish's head word is part of that dish, not a mention of its own", async () => {
  const { dishMentions } = await import("../sources/listicle.js");
  const foods = [{ entityKey: "cha-ca", name: "Chả cá" }, { entityKey: "bun-cha-ca", name: "Bún chả cá" }, { entityKey: "bo-ne", name: "Bò né" }];
  assert.deepEqual(dishMentions("Bánh mì Anh – quán bánh mì chả cá Nha Trang", foods).map((d) => d.entityKey), []);
  assert.deepEqual(dishMentions("Quán bún chả cá sứa", foods).map((d) => d.entityKey), ["bun-cha-ca"]);
  assert.deepEqual(dishMentions("Bánh mì chảo Nha Trang, bò né Bà Tạo", foods).map((d) => d.entityKey), ["bo-ne"]);
  assert.deepEqual(dishMentions("Món chính: chả cá chiên", foods).map((d) => d.entityKey), ["cha-ca"]);
});

test("FACTS (sample errors): occasional versions skipped; an alias as subject -> review; 'sữa bò' is not beef", async () => {
  const { proposalsFromSentence } = await import("../extract/foodFacts.js");
  const vocabulary = new FoodVocabulary(undefined, new FoodTaxonomy());
  const names = new Map([["banh-tet", ["Bánh tét"]], ["banh-xeo", ["Bánh xèo", "Bánh khoái"]], ["sua-dau-nanh", ["Sữa đậu nành"]]]);
  const run = (sentence, entityKey, canonicalNames = null) => proposalsFromSentence({ sentence, entityKey, namesByEntity: names, vocabulary, canonicalNames });
  assert.deepEqual(run("Cá biệt có bánh tét thập cẩm với nhân gồm trứng muối, tôm khô, lạp xưởng.", "banh-tet"), []);
  const alias = run("Bánh khoái là một loại bánh xèo, bên trong có nhân là tôm, chả, giá đỗ.", "banh-xeo", new Set(["banh xeo"]));
  assert.ok(alias.length > 0 && alias.every((p) => p.aliasSubject === true));
  const own = run("Bánh xèo có nhân là tôm và thịt heo.", "banh-xeo", new Set(["banh xeo"]));
  assert.ok(own.length > 0 && own.every((p) => !p.aliasSubject));
  assert.ok(!run("Sữa đậu nành chứa ít chất béo bão hòa hơn sữa bò.", "sua-dau-nanh").some((p) => p.key === "protein.beef"));
});

test("NAME SPANS: accented names match accent-sensitively ('phớ' ≠ 'phở'); unaccented names only unaccented text", async () => {
  const { nameSpans } = await import("../extract/foodFacts.js");
  assert.deepEqual(nameSpans("Thịt dùng cho món phở có thể là bò", ["Phở", "pho", "phớ"]).map((s) => s[2]), ["Phở"]);
  assert.deepEqual(nameSpans("ban pho ngon", ["Phở", "pho"]).map((s) => s[2]), ["pho"]);
});

test("QUERIES: per-dish, per-ward, official-menu and site: families are generated once each", async () => {
  const { generateQueries } = await import("../lib/queryGenerator.js");
  const q = generateQueries({ name: "Nha Trang", wards: ["Lộc Thọ"] }, { dishes: ["Bún cá", "Bánh căn"], sites: ["mia.vn"] });
  const has = (group, text) => q.some((x) => x.group === group && x.text === text);
  assert.ok(has("dish", "quán bún cá Nha Trang") && has("dish", "bánh căn Nha Trang thực đơn") && has("dish", "bún cá Nha Trang giá"));
  assert.ok(has("location", "quán ăn Lộc Thọ Nha Trang"));
  assert.ok(has("official_menu", "Nha Trang restaurant menu"));
  assert.ok(has("site", "site:mia.vn bánh căn Nha Trang"));
  assert.equal(new Set(q.map((x) => x.text.toLowerCase())).size, q.length);
});

test("GOOGLE PLACES (official API): food places imported with evidence; non-food ignored; idempotent; key never stored; no key -> nothing fetched", async () => {
  const { PLACES_ENDPOINT } = await import("../sources/googlePlaces.js");
  const repo = tmp();
  fs.mkdirSync(path.join(repo, "cfg"));
  fs.writeFileSync(path.join(repo, "cfg/seeds.json"), JSON.stringify({ wikipedia_base: "https://vi.wikipedia.org/wiki/", license: "x", attribution: "x", titles: [] }));
  fs.writeFileSync(path.join(repo, "cfg/official.json"), JSON.stringify({ merchants: [] }));
  fs.writeFileSync(path.join(repo, "cfg/places.json"), JSON.stringify({ max_queries: 1, categories: ["quán bún cá"] }));
  const response = {
    places: [
      { id: "ChIJ-bun-ca-1", displayName: { text: "Bún Cá Mẫu" }, formattedAddress: "170 Bạch Đằng, Tân Lập, Nha Trang", location: { latitude: 12.2412, longitude: 109.1901 }, rating: 4.6, userRatingCount: 1234, nationalPhoneNumber: "0258 123 456", websiteUri: "https://buncamau.example/", regularOpeningHours: { weekdayDescriptions: ["Thứ Hai: 06:00–21:00"] }, primaryType: "vietnamese_restaurant", types: ["restaurant", "food"] },
      { id: "ChIJ-hotel", displayName: { text: "Khách sạn Mẫu" }, formattedAddress: "1 Trần Phú, Nha Trang", primaryType: "hotel", types: ["lodging"] },
    ],
  };
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url: String(url), headers: opts.headers ?? {} });
    if (String(url).endsWith("/robots.txt")) return new Response("", { status: 404 });
    if (String(url) === PLACES_ENDPOINT) return new Response(JSON.stringify(response), { status: 200, headers: { "content-type": "application/json" } });
    return new Response("nf", { status: 404 });
  };
  const dbPath = path.join(repo, "out/kb.db");
  const opts = { repoRoot: repo, dbPath, rawRoot: path.join(repo, "data/raw"), outDir: path.dirname(dbPath), fetchImpl, wait: noWait, minIntervalMs: 0, seedsFile: path.join(repo, "cfg/seeds.json"), officialFile: path.join(repo, "cfg/official.json"), placesFile: path.join(repo, "cfg/places.json"), skipOsm: true, search: { configured: false } };
  // without a key: reported, nothing requested
  delete process.env.GOOGLE_PLACES_API_KEY;
  const none = await runPilot(opts);
  assert.match(none.summary.places.provider, /not_configured/);
  assert.ok(!calls.some((c) => c.url === PLACES_ENDPOINT));
  process.env.GOOGLE_PLACES_API_KEY = "TEST-KEY-123";
  try {
    const { summary } = await runPilot(opts);
    assert.deepEqual([summary.places.totals.places, summary.places.totals.not_food, summary.places.totals.merchants], [2, 1, 1]);
    assert.equal(calls.find((c) => c.url === PLACES_ENDPOINT).headers["X-Goog-Api-Key"], "TEST-KEY-123");
    await runPilot(opts); // again: the same place id -> the same merchant
    const db = new Database(dbPath, { readonly: true });
    assert.deepEqual(db.prepare(`SELECT name FROM kb_merchants`).all().map((r) => r.name), ["Bún Cá Mẫu"]);
    assert.equal(db.prepare(`SELECT value FROM kb_merchant_identifiers WHERE scheme = 'maps_place_id'`).get().value, "ChIJ-bun-ca-1");
    const loc = db.prepare(`SELECT latitude, longitude, coordinates_from, status FROM kb_merchant_locations`).get();
    assert.deepEqual(loc, { latitude: 12.2412, longitude: 109.1901, coordinates_from: "source", status: "published" });
    const r = db.prepare(`SELECT rating_source, rating, review_count, captured_at FROM kb_merchant_ratings ORDER BY id`).all();
    assert.equal(r.length, 1); // re-seen, not duplicated
    assert.deepEqual([r[0].rating_source, r[0].rating, r[0].review_count], ["google_maps", 4.6, 1234]);
    assert.ok(r[0].captured_at);
    assert.deepEqual(db.prepare(`SELECT field FROM kb_merchant_claims WHERE status = 'published' ORDER BY field`).all().map((x) => x.field), ["name", "opening_hours", "phone", "website"]);
    db.close();
    // the key is a request header only: no snapshot or meta file contains it
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
    assert.ok(!walk(path.join(repo, "data/raw")).some((f) => fs.readFileSync(f, "utf8").includes("TEST-KEY-123")));
  } finally {
    delete process.env.GOOGLE_PLACES_API_KEY;
  }
});

test("OFFICIAL HTML MENU: name -> [description] -> price; portion prices; no number from ranges / market price", async () => {
  const { officialMenuItems } = await import("../sources/officialHtmlMenu.js");
  const html = `<h2>Menu</h2><h3>Món nước</h3>
    <div>+</div><div>Bún cá dầm – chả cá – sứa</div><div>Giá bán:55,000₫</div>
    <h5>▴ Nha Trang Grilled Squid</h5><div>with Chimichurri</div><h5>▴ Mực Nha Trang nướng</h5><div>và sốt Chimichurri</div><div>240,000 ₫</div>
    <h5>Paella de mariscos</h5><h5>Cơm hầm hải sản Tây Ban Nha</h5><div>380,000 ₫ (for 1)</div><div>520,000 ₫ (for 2)</div>
    <h5>Tôm hùm</h5><div>Giá theo thời điểm</div>
    <h5>Lẩu hải sản</h5><div>300,000 - 500,000 ₫</div>`;
  const items = officialMenuItems(html).map((i) => [i.category, i.name, i.description, i.priceText, i.portion]);
  assert.deepEqual(items, [
    ["Món nước", "Bún cá dầm – chả cá – sứa", null, "55,000₫", null],
    ["Món nước", "Mực Nha Trang nướng", "và sốt Chimichurri", "240,000 ₫", null],
    ["Món nước", "Cơm hầm hải sản Tây Ban Nha", null, "380,000 ₫", "for 1"],
    ["Món nước", "Cơm hầm hải sản Tây Ban Nha", null, "520,000 ₫", "for 2"],
  ]);
  // product cards titled by a big heading: the heading is the name, the truncated paragraph its description
  const cards = `<h3>Nem nướng Nha Trang</h3><p>Nem nướng được chế biến từ thịt heo, thêm gia vị gia truyền, Sau đó...</p><div>50.000 ₫</div>`;
  assert.deepEqual(officialMenuItems(cards).map((i) => [i.name, i.description, i.priceText]), [["Nem nướng Nha Trang", "Nem nướng được chế biến từ thịt heo, thêm gia vị gia truyền, Sau đó...", "50.000 ₫"]]);
});

test("PDF TEXT: FlateDecode content + ToUnicode CMap -> lines; no text layer -> null (unreadable, not empty)", async () => {
  const zlib = await import("node:zlib");
  const { pdfToLines, pdfToText } = await import("../../../platform/knowledge/pdfText.js");
  const content = zlib.deflateSync(Buffer.from("BT /F1 12 Tf 1 0 0 1 50 700 Tm <0102> Tj ET BT /F1 12 Tf 1 0 0 1 50 680 Tm [<03>-300<04>] TJ ET", "latin1"));
  const cmap = "/CIDInit /ProcSet findresource begin 12 dict begin begincmap 1 begincodespacerange <00> <FF> endcodespacerange 2 beginbfchar <01> <0042 00FA 006E> <02> <0020 0063 00E1> endbfchar beginbfrange <03> <04> [<0035 0035> <006B>] endbfrange endcmap end end";
  const parts = [
    "%PDF-1.4\n",
    "1 0 obj << /Type /Page /Contents 2 0 R /Resources << /Font << /F1 3 0 R >> >> >> endobj\n",
    `2 0 obj << /Length ${content.length} /Filter /FlateDecode >> stream\n`,
  ];
  const pdf = Buffer.concat([Buffer.from(parts.join(""), "latin1"), content, Buffer.from(`\nendstream endobj\n3 0 obj << /Type /Font /Subtype /Type0 /ToUnicode 4 0 R >> endobj\n4 0 obj << /Length ${cmap.length} >> stream\n${cmap}\nendstream endobj\n%%EOF`, "latin1")]);
  assert.deepEqual(pdfToLines(pdf), ["Bún cá", "55 k"]);
  assert.equal(pdfToText(Buffer.from("%PDF-1.4 binary-ish", "latin1")), null);
  assert.equal(pdfToText(Buffer.from("not a pdf")), null);
});

test("PRICE SCALE: prices 'in thousands' are scaled only with the same source's verified declaration", async () => {
  const { KnowledgeStore } = await import("../../../platform/knowledge/store.js");
  const { MerchantDiscoveryStore } = await import("../../../platform/knowledge/discoveryStore.js");
  const { createKnowledgeConnection, runKnowledgeMigrations } = await import("../../../platform/knowledge/db.js");
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "m.txt"), "Quán Mẫu. All prices are in VND (,000). Bún Cá Nha Trang Bún với cá tươi, chả cá, sứa 210", "utf8");
  const db = createKnowledgeConnection(":memory:");
  runKnowledgeMigrations(db);
  const knowledge = new KnowledgeStore({ db, rawRoot: dir });
  const discovery = new MerchantDiscoveryStore({ knowledge });
  const s = knowledge.registerSource({ url: "https://quan.example/menu", sourceType: "merchant_official", rawPath: "m.txt", contentType: "text/plain", fetchedAt: "2026-09-26T00:00:00Z" });
  const seen = "2026-09-26T00:00:00Z";
  const m = discovery.upsertMerchant({ name: "Quán Mẫu", identifiers: [], seenAt: seen, evidence: { sourceId: s.id, quote: "Quán Mẫu.", extraction: "explicit" } });
  const item = { sourceId: s.id, quote: "Bún Cá Nha Trang Bún với cá tươi, chả cá, sứa 210", extraction: "explicit" };
  const p = discovery.proposeProduct({ merchantId: m.merchantId, originalName: "Bún Cá Nha Trang", observation: "menu", evidence: item, seenAt: seen });
  const ok = discovery.proposePrice({ productId: p.productId, priceTextOriginal: "210", evidence: item, capturedAt: seen, scale: { factor: 1000, evidence: { sourceId: s.id, quote: "All prices are in VND (,000).", extraction: "explicit" } } });
  assert.deepEqual([ok.outcome, ok.price], ["published", 210000]);
  const bad = discovery.proposePrice({ productId: p.productId, variant: "x", priceTextOriginal: "210", evidence: item, capturedAt: seen, scale: { factor: 1000, evidence: { sourceId: s.id, quote: "Quán Mẫu.", extraction: "explicit" } } });
  assert.notEqual(bad.outcome, "published");
  db.close();
});

test("FACTS (final sample errors): 'thịnh hành' ≠ onion, 'nấm men' ≠ mushroom, 'bất kỳ' optional, 'bánh phổ biến' ≠ bánh phở, a course is not a variant target", async () => {
  const { proposalsFromSentence, variantProposals } = await import("../extract/foodFacts.js");
  const vocabulary = new FoodVocabulary(undefined, new FoodTaxonomy());
  const names = new Map([["tra", ["Trà"]], ["me", ["Mẻ"]], ["okowa", ["Okowa"]], ["banh-xeo", ["Bánh xèo"]], ["banh-pho", ["Bánh phở"]], ["brownie", ["Brownie nóng hổi"]], ["trang-mieng", ["Tráng miệng"]], ["mochi", ["Mochi"]], ["banh-giay", ["Bánh giầy"]]]);
  const facts = (sentence, entityKey) => proposalsFromSentence({ sentence, entityKey, namesByEntity: names, vocabulary });
  assert.deepEqual(facts("Đến thời Đường, trà dạng bánh vẫn thịnh hành nhưng kỹ thuật đã dần thay đổi.", "tra"), []);
  assert.deepEqual(facts("Thức ăn của con mẻ sẽ là nấm men.", "me"), []);
  assert.deepEqual(facts("Okowa có thể trộn với bất kỳ loại thành phần thịt hoặc rau.", "okowa"), []);
  const variant = (sentence, entityKey) => variantProposals({ sentence, entityKey, namesByEntity: names }).map((p) => p.value);
  assert.deepEqual(variant("Bánh xèo là một loại bánh phổ biến ở châu Á.", "banh-xeo"), []);
  assert.deepEqual(variant("Brownie nóng hổi là món tráng miệng có xuất xứ từ Ấn Độ.", "brownie"), []);
  assert.deepEqual(variant("Mochi là một loại bánh giầy làm từ gạo nếp.", "mochi"), ["banh-giay"]);
  // "pho mát" (cheese) is not phở's unaccented search form
  const withPho = new Map([...names, ["pho", ["Phở", "pho"]], ["crottin", ["Crottin de Chavignol"]]]);
  assert.deepEqual(variantProposals({ sentence: "Crottin de Chavignol là loại pho mát dê nổi tiếng nhất.", entityKey: "crottin", namesByEntity: withPho }), []);
});

test("FAILED QUEUE: failures are counted per source and a source is given up after 3 attempts; success clears it", () => {
  const dir = tmp();
  const q = failedQueue(dir);
  for (let i = 0; i < 3; i++) q.record("https://a.example/x", "timeout");
  q.record("https://a.example/y", "timeout");
  q.save();
  const again = failedQueue(dir);
  assert.equal(again.exhausted("https://a.example/x"), true);
  assert.equal(again.exhausted("https://a.example/y"), false);
  again.clear("https://a.example/y");
  again.save();
  assert.deepEqual(Object.keys(failedQueue(dir).state), ["https://a.example/x"]);
});

test("RESILIENCE: an article that breaks extraction is recorded and the run goes on; inventory is persisted", async () => {
  const repo = tmp();
  fs.mkdirSync(path.join(repo, "cfg"));
  const WIKI = "https://vi.wikipedia.org/wiki/";
  fs.writeFileSync(path.join(repo, "cfg/seeds.json"), JSON.stringify({ wikipedia_base: WIKI, license: "x", attribution: "x", groups: { a: ["Bún cá"] } }));
  fs.writeFileSync(path.join(repo, "cfg/official.json"), JSON.stringify({ merchants: [] }));
  fs.writeFileSync(path.join(repo, "cfg/articles.json"), JSON.stringify({ source_type: "blog", region_id: "vn.khanh-hoa.nha-trang", articles: [{ url: "https://b.example/n/broken-quan/" }] }));
  fs.writeFileSync(path.join(repo, "cfg/families.json"), JSON.stringify({ families: [{ id: "b", source_type: "blog", listing: { url_template: "https://b.example/list/{n}", from: 1, to: 2, stop_after_empty: 1 }, article_pattern: "^https://b\\.example/n/[^/]+/$" }] }));
  const net = fakeNetwork({
    "https://vi.wikipedia.org/robots.txt": { body: "" },
    [articleUrl(WIKI, "Bún cá")]: { body: `<h1 id="firstHeading">Bún cá</h1><div id="mw-content-text"><p>Bún cá là món ăn sáng.</p></div>` },
    "https://b.example/robots.txt": { status: 404, body: "" },
    "https://b.example/list/1": { body: `<a href="/n/quan-bun-ca-ngon/">x</a>` },
    // a page whose raw file disappears between fetch and registration is simulated by an invalid content type
    "https://b.example/n/broken-quan/": { body: "<h2>1. Quán A</h2><p>Địa chỉ: 1 Trần Phú</p>", contentType: "text/html" },
    "https://b.example/n/quan-bun-ca-ngon/": { body: "<h2>1. Bún cá Cô Ba</h2><p>Địa chỉ: 105 Hoàng Hoa Thám, Nha Trang</p>" },
  });
  const dbPath = path.join(repo, "out/kb.db");
  // break the first article: its snapshot is removed right after it is stored
  const realStore = RawFetcher.prototype.store;
  RawFetcher.prototype.store = function (args) {
    const r = realStore.call(this, args);
    if (args.url === "https://b.example/n/broken-quan/") fs.rmSync(path.join(repo, r.rawPath));
    return r;
  };
  try {
    const { summary } = await runPilot({ repoRoot: repo, dbPath, rawRoot: path.join(repo, "data/raw"), outDir: path.dirname(dbPath), fetchImpl: net.fetchImpl, wait: noWait, minIntervalMs: 0, seedsFile: path.join(repo, "cfg/seeds.json"), officialFile: path.join(repo, "cfg/official.json"), articlesFile: path.join(repo, "cfg/articles.json"), familiesFile: path.join(repo, "cfg/families.json"), skipOsm: true, search: { configured: false } });
    assert.equal(summary.articles.failed.length, 1);
    assert.equal(summary.articles.pages, 1);
    const db = new Database(dbPath, { readonly: true });
    assert.deepEqual(db.prepare(`SELECT name FROM kb_merchants`).all().map((r) => r.name), ["Bún cá Cô Ba"]);
    db.close();
    const inv = JSON.parse(fs.readFileSync(path.join(repo, "out/source-inventory.json"), "utf8"));
    assert.deepEqual(inv.articles.map((a) => a.url), ["https://b.example/n/quan-bun-ca-ngon/"]);
    assert.equal(JSON.parse(fs.readFileSync(path.join(repo, "out/failed-sources.json"), "utf8"))["https://b.example/n/broken-quan/"].attempts, 1);
  } finally {
    RawFetcher.prototype.store = realStore;
  }
});
