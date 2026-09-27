// Food Discovery (read-only) + answer builder over a knowledge.db fixture.
// Rows are SYNTHETIC TEST FIXTURES written with SQL (made-up merchants).
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createKnowledgeConnection, runKnowledgeMigrations } from "../../knowledge/db.js";
import { FoodDiscoveryService, openKnowledgeReadOnly } from "../../knowledge/foodDiscovery.js";
import { AnswerBuilder } from "../../knowledge/answer.js";

function fixture() {
  const file = path.join(os.tmpdir(), `kb-discovery-${randomUUID()}.db`);
  const db = createKnowledgeConnection(file);
  runKnowledgeMigrations(db);
  const ins = (sql, ...p) => db.prepare(sql).run(...p).lastInsertRowid;
  const src = (url, type) => ins(`INSERT INTO kb_sources (url, domain, source_type, fetched_at, content_type, content_hash, raw_path) VALUES (?, ?, ?, '2026-09-20', 'text/html', ?, 'raw/x')`, url, new URL(url).hostname, type, randomUUID());
  const wiki = src("https://wiki.example/bun-cha-ca", "encyclopedia");
  const dir = src("https://dir.example/list", "directory");
  const ev = (s = wiki, quote = "fixture") => ins(`INSERT INTO kb_evidence (source_id, quote, extraction, verification) VALUES (?, ?, 'explicit', 'verified')`, s, quote);
  ins(`INSERT INTO kb_regions (id, name, level) VALUES ('vn', 'Việt Nam', 'country'), ('vn.khanh-hoa.nha-trang', 'Nha Trang', 'locality')`);
  const food = (key, name, extraNames = []) => {
    const id = ins(`INSERT INTO kb_food_entities (key, canonical_name, normalized_name, status) VALUES (?, ?, ?, 'published')`, key, name, key.replace(/-/g, " "));
    for (const [n, kind] of [[name, "canonical"], ...extraNames.map((x) => [x, "alias"])]) {
      ins(`INSERT INTO kb_food_names (entity_id, name, normalized, kind, origin, status) VALUES (?, ?, ?, ?, 'sourced', 'published')`, id, n, n.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/gi, "d").toLowerCase(), kind);
    }
    return id;
  };
  const claim = (entityId, kind, key, value, level = null) => ins(`INSERT INTO kb_claims (entity_id, kind, key, value, level, evidence_id, status, confidence) VALUES (?, ?, ?, ?, ?, ?, 'published', 0.75)`, entityId, kind, key, value, level, ev());
  const bunCa = food("bun-cha-ca", "Bún chả cá", ["bún cá"]);
  claim(bunCa, "facet", "dish_form", "soup_dish");
  claim(bunCa, "attribute", "temperature.serving", "hot");
  claim(bunCa, "ingredient", "protein.seafood.fish_cake", "unspecified");
  claim(bunCa, "relation", "regional_specialty", "vn.khanh-hoa.nha-trang");
  claim(bunCa, "attribute", "taste.spicy", null, "adjustable");
  const nem = food("nem-nuong", "Nem nướng");
  claim(nem, "facet", "preparation", "grill");
  claim(nem, "ingredient", "protein.pork", "unspecified");
  const banhCan = food("banh-can", "Bánh căn");
  claim(banhCan, "attribute", "texture.crispy", null, "medium");
  claim(banhCan, "ingredient", "protein.seafood.shrimp", "unspecified");
  claim(banhCan, "facet", "meal_period", "breakfast");
  const banhXeo = food("banh-xeo", "Bánh xèo"); // no facts at all: everything unknown
  claim(food("che", "Chè"), "attribute", "taste.spicy", null, "none");

  const merchant = (key, name) => ins(`INSERT INTO kb_merchants (key, name, normalized_name, status, first_seen_at, last_seen_at) VALUES (?, ?, ?, 'candidate', '2026-09-20', '2026-09-20')`, key, name, key);
  const product = (m, name) => ins(`INSERT INTO kb_merchant_products (merchant_id, original_name, normalized_name, evidence_id, status, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, 'published', '2026-09-20', '2026-09-20')`, m, name, name.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/gi, "d").toLowerCase(), ev(dir));
  const price = (p, v, at = "2026-09-20") => ins(`INSERT INTO kb_product_prices (product_id, price, price_text_original, evidence_id, captured_at, last_seen_at, status) VALUES (?, ?, ?, ?, ?, ?, 'published')`, p, v, String(v), ev(dir), at, at);
  const link = (f, p) => ins(`INSERT INTO kb_food_product_links (food_entity_id, kb_product_id, match_type, evidence_id, status) VALUES (?, ?, 'exact', ?, 'published')`, f, p, ev(dir));
  const loc = (m, address, lat, lng) => ins(`INSERT INTO kb_merchant_locations (merchant_id, address_original, street, latitude, longitude, coordinates_from, evidence_id, captured_at, last_seen_at, status) VALUES (?, ?, ?, ?, ?, 'source', ?, '2026-09-20', '2026-09-20', 'published')`, m, address, address.replace(/^\d+\s+/, ""), lat, lng, ev(dir));
  const rating = (m, r, n) => ins(`INSERT INTO kb_merchant_ratings (merchant_id, rating_source, rating, rating_scale, review_count, evidence_id, captured_at, last_seen_at, status) VALUES (?, 'dir.example', ?, 5, ?, ?, '2026-09-20', '2026-09-20', 'published')`, m, r, n, ev(dir));
  const hours = (m, text, structured) => ins(`INSERT INTO kb_merchant_claims (merchant_id, field, value_json, original_text, evidence_id, captured_at, last_seen_at, status) VALUES (?, 'opening_hours', ?, ?, ?, '2026-09-20', '2026-09-20', 'published')`, m, structured ? JSON.stringify(structured) : null, text, ev(dir));
  const cuisine = (m, tags) => ins(`INSERT INTO kb_merchant_claims (merchant_id, field, value_json, original_text, evidence_id, captured_at, last_seen_at, status) VALUES (?, 'cuisine', ?, ?, ?, '2026-09-20', '2026-09-20', 'published')`, m, JSON.stringify(tags), tags.join(";"), ev(dir));

  const a = merchant("quan-a", "Quán A");
  const b = merchant("quan-b", "Quán B");
  const c = merchant("quan-c", "Quán C");
  const d = merchant("quan-d", "Quán D Hải Sản");
  const pa = product(a, "Bún chả cá");
  const pb = product(b, "Bún cá");
  const pc = product(c, "Bún chả cá đặc biệt");
  const pan = product(a, "Nem nướng");
  [[pa, 40000], [pb, 45000], [pc, 55000], [pan, 30000]].forEach(([p, v]) => price(p, v));
  link(bunCa, pa);
  link(bunCa, pb);
  link(nem, pan);
  // pc is not linked: found by name search only, labelled so
  loc(a, "12 Trần Phú", 12.2451, 109.1943);
  loc(b, "5 Hùng Vương", 12.2400, 109.1900);
  loc(c, "8 Trần Phú", 12.2460, 109.1945);
  rating(a, 4.2, 80);
  rating(b, 4.7, 30);
  hours(a, "Mo-Su 06:00-10:00", Object.fromEntries(["mo", "tu", "we", "th", "fr", "sa", "su"].map((k) => [k, [["06:00", "10:00"]]])));
  hours(b, "6h - 11h", null); // text only: never answers "open now"
  cuisine(d, ["seafood", "vietnamese"]);
  ins(`INSERT INTO kb_merchant_links (kb_merchant_id, platform_merchant_id, linked_by) VALUES (?, 'PLAT_A', 'founder')`, a);
  db.close();
  return { file, ids: { a, b, c, d, bunCa, banhXeo } };
}

function service(file, opts = {}) {
  return new FoodDiscoveryService({ db: openKnowledgeReadOnly(file), now: () => new Date("2026-09-25T07:30:00"), ...opts });
}
const names = (r) => r.merchants.map((m) => m.name);

test("DISCOVERY: one food -> many merchants (linked + name-matched), with each merchant's own price", () => {
  const { file } = fixture();
  const r = service(file).search("Tìm bún cá");
  assert.deepEqual(names(r).sort(), ["Quán A", "Quán B", "Quán C"]);
  const prices = Object.fromEntries(r.merchants.map((m) => [m.name, m.products.find((p) => p.foods.includes("bun-cha-ca") || /bún/i.test(p.name)).prices[0].price]));
  assert.deepEqual(prices, { "Quán A": 40000, "Quán B": 45000, "Quán C": 55000 });
  assert.equal(r.merchants.find((m) => m.name === "Quán C").products[0].match, "name"); // not a knowledge link
});

test("DISCOVERY: price, combination, location, open-now filters use recorded data only", () => {
  const { file } = fixture();
  const s = service(file);
  assert.deepEqual(names(s.search("Tìm bún cá dưới 50k")).sort(), ["Quán A", "Quán B"]);
  assert.deepEqual(names(s.search("Quán nào bán bún cá và nem nướng?")), ["Quán A"]);
  assert.deepEqual(names(s.search("Tìm quán bún cá gần Trần Phú")).sort(), ["Quán A", "Quán C"]);
  const open = s.search("Tìm quán bún cá đang mở"); // 07:30: A (06-10 structured) open; B text-only -> unknown
  assert.deepEqual(names(open), ["Quán A"]);
  assert.ok(open.notes.some((n) => n.startsWith("OPEN_STATUS_UNKNOWN")));
});

test("DISCOVERY: sorting only on request — rating, reviews, price, menu size, distance; never 'the best'", () => {
  const { file } = fixture();
  const s = service(file);
  assert.deepEqual(names(s.search("Tìm quán có rating cao bán bún cá")).slice(0, 2), ["Quán B", "Quán A"]);
  assert.deepEqual(names(s.search("quán bún cá nhiều đánh giá")).slice(0, 2), ["Quán A", "Quán B"]);
  assert.deepEqual(names(s.search("bún cá giá rẻ")), ["Quán A", "Quán B", "Quán C"]);
  assert.equal(names(s.search("quán nhiều món"))[0], "Quán A");
  const near = s.search("quán bún cá gần tôi", { userLocation: { lat: 12.2459, lng: 109.1945 } });
  assert.equal(names(near)[0], "Quán C");
  assert.ok(s.search("quán bún cá gần tôi").notes.includes("NEED_USER_LOCATION"));
  const subjective = s.search("Bún cá ở đâu ngon?");
  assert.ok(subjective.notes.includes("SUBJECTIVE_NOT_RANKED"));
  assert.deepEqual(names(subjective), ["Quán A", "Quán B", "Quán C"]); // plain, deterministic order
});

test("DISCOVERY: semantic food search — hot, crispy bánh, breakfast, seafood merchants, Nha Trang specialty", () => {
  const { file } = fixture();
  const s = service(file);
  const ok = (r) => r.foods.filter((f) => f.ok).map((f) => f.key);
  assert.deepEqual(ok(s.search("Tìm món nóng")), ["bun-cha-ca"]);
  assert.deepEqual(ok(s.search("Tìm bánh giòn")), ["banh-can"]); // bánh xèo: crispiness unknown -> not claimed
  assert.ok(s.search("Tìm bánh giòn").foods.find((f) => f.key === "banh-xeo").unknown.length);
  assert.deepEqual(ok(s.search("tìm món ăn sáng")), ["banh-can"]);
  assert.deepEqual(ok(s.search("món gì đặc sản Nha Trang")), ["bun-cha-ca"]);
  assert.deepEqual(ok(s.search("Tìm món cay nhẹ có tôm")), []); // bánh căn has shrimp, but its spiciness is unknown
  assert.deepEqual(names(s.search("Tìm quán hải sản")), ["Quán D Hải Sản"]); // by the merchant's own cuisine tag
});

test("DISCOVERY: 'không cay' returns only dishes KNOWN not spicy; an allergy excludes the unknown", () => {
  const { file } = fixture();
  const s = service(file);
  const notSpicy = s.search("Tìm món không cay").foods.filter((f) => f.ok).map((f) => f.key).sort();
  assert.deepEqual(notSpicy, ["bun-cha-ca", "che"]); // chè: none; bún chả cá: chili on the side (adjustable)
  const allergy = s.search("tôi dị ứng tôm, tìm bánh");
  const verdicts = Object.fromEntries(allergy.foods.map((f) => [f.key, f.ok]));
  assert.equal(verdicts["banh-can"], false); // has shrimp
  assert.equal(verdicts["banh-xeo"], false); // unknown ingredients: not safe to promise
});

test("DISCOVERY ≠ ORDERING: orderable only when the platform catalog confirms", () => {
  const { file } = fixture();
  const checks = [];
  const s = service(file, { isOrderable: (ref) => (checks.push(ref), ref.platformMerchantId === "PLAT_A") });
  const r = s.search("Tìm bún cá");
  const byName = Object.fromEntries(r.merchants.map((m) => [m.name, m.orderable]));
  assert.deepEqual(byName, { "Quán A": true, "Quán B": false, "Quán C": false });
  assert.ok(checks.every((c) => c.platformMerchantId === "PLAT_A"));
  // default: nothing is orderable
  assert.ok(service(file).search("Tìm bún cá").merchants.every((m) => !m.orderable));
});

test("READ-ONLY: the discovery connection cannot write", () => {
  const { file } = fixture();
  const db = openKnowledgeReadOnly(file);
  assert.throws(() => db.prepare(`DELETE FROM kb_merchants`).run(), /readonly/i);
  assert.throws(() => openKnowledgeReadOnly(path.join(os.tmpdir(), `missing-${randomUUID()}.db`)), /unable to open|does not exist|SQLITE_CANTOPEN/i);
});

test("ANSWER: facts with source+date, typical knowledge hedged, unknown said plainly, reference prices, orderable marked", () => {
  const { file } = fixture();
  const s = service(file, { isOrderable: (ref) => ref.platformMerchantId === "PLAT_A" });
  const text = new AnswerBuilder().build(s.search("Tìm quán có rating cao bán bún cá"));
  assert.match(text, /Bún chả cá thường: .*món nước/);
  assert.match(text, /\(theo wiki\.example\)/);
  assert.match(text, /giá tham khảo 45\.000đ, ghi nhận 20\/09\/2026 \(dir\.example\)/);
  assert.match(text, /⭐ 4\.7\/5 \(30 đánh giá\) theo dir\.example, ghi nhận 20\/09\/2026/);
  assert.match(text, /✅ Quán này đặt được qua FOOD/);
  assert.match(text, /Thông tin tham khảo — chưa đặt qua FOOD được/);
  assert.doesNotMatch(text, /ngon nhất|tốt nhất|số một/);
  // asked about by name -> "unknown" is said plainly; a general search does not list every unknown dish
  const unknown = new AnswerBuilder().build(s.search("bánh xèo có giòn không"));
  assert.match(unknown, /Bánh xèo: em chưa có thông tin về giòn/);
  assert.doesNotMatch(new AnswerBuilder().build(s.search("Tìm bánh giòn")), /Bánh xèo/);
  const tcm = new AnswerBuilder().build(s.search("đồ ăn tính nóng"));
  assert.match(tcm, /không đánh giá "tính nóng"/);
  const subjective = new AnswerBuilder().build(s.search("Bún cá ở đâu ngon?"));
  assert.match(subjective, /không xếp hạng/);
});

test("REGIONS: a specialty of the wider province answers a question about a city inside it, labelled with its own region", () => {
  const { file } = fixture();
  const w = createKnowledgeConnection(file);
  w.prepare(`INSERT INTO kb_regions (id, name, level) VALUES ('vn.khanh-hoa', 'Khánh Hòa', 'province')`).run();
  w.prepare(`UPDATE kb_regions SET parent_id = 'vn.khanh-hoa' WHERE id = 'vn.khanh-hoa.nha-trang'`).run();
  w.prepare(`UPDATE kb_regions SET parent_id = 'vn' WHERE id = 'vn.khanh-hoa'`).run();
  const nem = w.prepare(`SELECT id FROM kb_food_entities WHERE key = 'nem-nuong'`).get().id;
  const ev = w.prepare(`SELECT id FROM kb_evidence LIMIT 1`).get().id;
  w.prepare(`INSERT INTO kb_claims (entity_id, kind, key, value, evidence_id, status) VALUES (?, 'relation', 'regional_specialty', 'vn.khanh-hoa', ?, 'published')`).run(nem, ev);
  w.close();
  const s = service(file);
  const r = s.search("món gì đặc sản Nha Trang");
  assert.deepEqual(r.foods.filter((f) => f.ok).map((f) => f.key).sort(), ["bun-cha-ca", "nem-nuong"]);
  const text = new AnswerBuilder().build(r);
  assert.match(text, /Đặc sản Khánh Hòa/); // not relabelled as a Nha Trang specialty
  assert.match(text, /Đặc sản Nha Trang/);
});

test("NO HALLUCINATION: a dish without published facts is described as unknown, never filled in", () => {
  const { file } = fixture();
  const s = service(file);
  const r = s.search("bánh xèo");
  assert.deepEqual(r.foods.map((f) => [f.key, f.facts.length]), [["banh-xeo", 0]]);
  assert.match(new AnswerBuilder().describeFood(r.foods[0]), /chưa có thông tin mô tả/);
});
