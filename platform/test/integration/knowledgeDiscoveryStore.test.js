// Merchant discovery writes: dedup, provenance, history, conflicts, links.
// Sources are SYNTHETIC TEST FIXTURES (made-up merchants) written to a temp dir.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createKnowledgeConnection, runKnowledgeMigrations } from "../../knowledge/db.js";
import { KnowledgeStore } from "../../knowledge/store.js";
import { MerchantDiscoveryStore } from "../../knowledge/discoveryStore.js";

const MAP = {
  elements: [
    { type: "node", id: 101, lat: 12.2451, lon: 109.1943, tags: { name: "Quán Bún Cá Mẫu", cuisine: "vietnamese;noodle", "addr:street": "Trần Phú", "addr:housenumber": "12", opening_hours: "Mo-Su 06:00-10:00", phone: "+84 258 000 0001" } },
    { type: "node", id: 102, lat: 12.2452, lon: 109.1944, tags: { name: "Quán Bún Cá Mẫu", "addr:street": "Trần Phú" } },
    { type: "node", id: 103, lat: 12.3000, lon: 109.2000, tags: { name: "Quán Bún Cá Mẫu" } },
  ],
};
const DIRECTORY = `<html><body><h1>Quán Bún Cá Mẫu</h1>
<p>Địa chỉ: 12 Trần Phú. Điện thoại: +84 258 000 0001. Giờ mở cửa: 6h - 11h.</p>
<ul><li>Bún cá - 45.000đ</li><li>Bún cá đặc biệt - 55.000đ</li><li>Bún sứa - 40K</li></ul>
<p>Đánh giá 4.5/5 từ 120 lượt</p></body></html>`;
const DIRECTORY_LATER = DIRECTORY.replace("Bún cá - 45.000đ", "Bún cá - 50.000đ").replace("4.5/5 từ 120", "4.6/5 từ 150");
const BLOG = `<html><body><p>Quán Bún Cá Mẫu bán Bún cá - 48.000đ, mở cửa 5h - 10h.</p></body></html>`;

function setup() {
  const dir = path.join(os.tmpdir(), `kb-discovery-${randomUUID()}`);
  fs.mkdirSync(dir, { recursive: true });
  const files = { "map.json": JSON.stringify(MAP), "dir.html": DIRECTORY, "dir2.html": DIRECTORY_LATER, "blog.html": BLOG };
  for (const [n, c] of Object.entries(files)) fs.writeFileSync(path.join(dir, n), c, "utf8");
  const db = createKnowledgeConnection(":memory:");
  runKnowledgeMigrations(db);
  const knowledge = new KnowledgeStore({ db, rawRoot: dir });
  const d = new MerchantDiscoveryStore({ knowledge });
  const reg = (url, type, file, ct, at = "2026-09-20") => knowledge.registerSource({ url, sourceType: type, rawPath: file, contentType: ct, fetchedAt: at, ...(type === "osm" ? { license: "ODbL-1.0", attribution: "© OpenStreetMap contributors" } : {}) });
  const src = {
    map: reg("https://overpass.example/q1", "osm", "map.json", "application/json"),
    dir: reg("https://dir.example/quan-mau", "directory", "dir.html", "text/html"),
    dir2: reg("https://dir.example/quan-mau?v=2", "directory", "dir2.html", "text/html", "2026-09-25"),
    blog: reg("https://blog.example/an-sang", "blog", "blog.html", "text/html"),
  };
  const el = (i) => ({ sourceId: src.map.id, locator: `/elements/${i}`, quote: JSON.stringify(MAP.elements[i]), extraction: "explicit" });
  const q = (source, quote) => ({ sourceId: source.id, quote, extraction: "explicit" });
  return { db, knowledge, d, src, el, q };
}

const osmMerchant = (d, el, i, extra = {}) =>
  d.upsertMerchant({ name: MAP.elements[i].tags.name, identifiers: [{ scheme: "osm", value: `node/${MAP.elements[i].id}` }], lat: MAP.elements[i].lat, lng: MAP.elements[i].lon, seenAt: "2026-09-20", evidence: el(i), ...extra });

test("EVIDENCE: JSON sources are verified by pointer — the quote must be exactly the value there", () => {
  const { d, src, el } = setup();
  assert.equal(osmMerchant(d, el, 0).outcome, "published");
  const forged = d.upsertMerchant({ name: "Quán Bún Cá Mẫu", identifiers: [], seenAt: "2026-09-20", evidence: { sourceId: src.map.id, locator: "/elements/0", quote: '{"name":"Quán Bún Cá Mẫu"}', extraction: "explicit" } });
  assert.equal(forged.outcome, "rejected");
  assert.equal(forged.reasons[0].code, "QUOTE_NOT_FOUND");
  const missing = d.upsertMerchant({ name: "X", identifiers: [], seenAt: "2026-09-20", evidence: { sourceId: src.map.id, locator: "/elements/99", quote: "X", extraction: "explicit" } });
  assert.equal(missing.outcome, "rejected");
});

test("DEDUP: a strong identifier matches; equal names nearby only become a duplicate candidate; far away stays separate", () => {
  const { db, d, el, q, src } = setup();
  const a = osmMerchant(d, el, 0);
  d.proposeLocation({ merchantId: a.merchantId, addressOriginal: "Trần Phú", street: "Trần Phú", lat: 12.2451, lng: 109.1943, coordinatesFrom: "source", evidence: el(0), capturedAt: "2026-09-20" });
  // the same OSM element again -> same merchant
  assert.equal(osmMerchant(d, el, 0).action, "matched");
  // another element, same name, 15 m away -> NOT merged, flagged
  const twin = osmMerchant(d, el, 1);
  assert.equal(twin.action, "created_with_duplicate_candidate");
  assert.notEqual(twin.merchantId, a.merchantId);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM kb_duplicate_candidates WHERE status = 'pending'`).get().n, 1);
  // same name 6 km away -> a different merchant, no flag
  d.proposeLocation({ merchantId: twin.merchantId, addressOriginal: "Trần Phú", lat: 12.2452, lng: 109.1944, coordinatesFrom: "source", evidence: el(1), capturedAt: "2026-09-20" });
  const far = osmMerchant(d, el, 2);
  assert.equal(far.action, "created");
  // a directory page naming the merchant with the SAME PHONE at the same place -> matched
  const byPhone = d.upsertMerchant({ name: "Quán Bún Cá Mẫu", identifiers: [{ scheme: "phone", value: "+842580000001" }], lat: 12.24512, lng: 109.19431, seenAt: "2026-09-20", evidence: q(src.dir, "Quán Bún Cá Mẫu") });
  // phone identifier was not yet on the OSM merchant -> no match by phone; name twin nearby -> candidate, not merge
  assert.notEqual(byPhone.merchantId, a.merchantId);
  assert.ok(["created_with_duplicate_candidate"].includes(byPhone.action));
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM kb_merchants`).get().n, 4);
});

test("DEDUP: phone or website match only counts at the same place", () => {
  const { d, el, q, src } = setup();
  const a = d.upsertMerchant({ name: "Quán Bún Cá Mẫu", identifiers: [{ scheme: "osm", value: "node/101" }, { scheme: "phone", value: "+842580000001" }], lat: 12.2451, lng: 109.1943, seenAt: "2026-09-20", evidence: el(0) });
  d.proposeLocation({ merchantId: a.merchantId, addressOriginal: "Trần Phú", lat: 12.2451, lng: 109.1943, coordinatesFrom: "source", evidence: el(0), capturedAt: "2026-09-20" });
  const same = d.upsertMerchant({ name: "Quán Bún Cá Mẫu", identifiers: [{ scheme: "phone", value: "+842580000001" }], lat: 12.2452, lng: 109.1944, seenAt: "2026-09-21", evidence: q(src.dir, "Quán Bún Cá Mẫu") });
  assert.equal(same.merchantId, a.merchantId);
  assert.equal(same.matchedBy, "phone+place");
});

test("MERCHANT FACTS: re-observation moves last_seen; different sources disagreeing are all kept as a recorded conflict", () => {
  const { db, d, el, q, src } = setup();
  const { merchantId } = osmMerchant(d, el, 0);
  const osmHours = d.proposeMerchantClaim({ merchantId, field: "opening_hours", value: { mo_su: [["06:00", "10:00"]] }, originalText: "Mo-Su 06:00-10:00", evidence: el(0), capturedAt: "2026-09-20" });
  assert.equal(osmHours.outcome, "published");
  const again = d.proposeMerchantClaim({ merchantId, field: "opening_hours", value: { mo_su: [["06:00", "10:00"]] }, originalText: "Mo-Su 06:00-10:00", evidence: el(0), capturedAt: "2026-09-24" });
  assert.equal(again.touched, true);
  assert.equal(db.prepare(`SELECT last_seen_at FROM kb_merchant_claims WHERE id = ?`).get(osmHours.claimId).last_seen_at, "2026-09-24");
  const dirHours = d.proposeMerchantClaim({ merchantId, field: "opening_hours", value: null, originalText: "6h - 11h", evidence: q(src.dir, "Giờ mở cửa: 6h - 11h."), capturedAt: "2026-09-20" });
  assert.equal(dirHours.outcome, "published");
  const flagged = db.prepare(`SELECT id, conflict FROM kb_merchant_claims WHERE field = 'opening_hours' ORDER BY id`).all();
  assert.deepEqual(flagged.map((r) => r.conflict), [1, 1]);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM kb_source_conflicts WHERE subject_type = 'merchant_claim'`).get().n, 1);
  // additive facts (several cuisines/phones) are not conflicts
  d.proposeMerchantClaim({ merchantId, field: "cuisine", value: ["vietnamese", "noodle"], originalText: "vietnamese;noodle", evidence: el(0), capturedAt: "2026-09-20" });
  // unsupported text -> review, never published
  assert.equal(d.proposeMerchantClaim({ merchantId, field: "delivery", value: true, originalText: "có giao hàng", evidence: q(src.dir, "Giờ mở cửa: 6h - 11h."), capturedAt: "2026-09-20" }).outcome, "review");
});

test("LOCATION: coordinates must be in the evidence; a different address from another source is a conflict", () => {
  const { db, d, el, q, src } = setup();
  const { merchantId } = osmMerchant(d, el, 0);
  assert.equal(d.proposeLocation({ merchantId, addressOriginal: "Trần Phú", lat: 12.9999, lng: 109.1943, coordinatesFrom: "source", evidence: el(0), capturedAt: "2026-09-20" }).outcome, "review");
  assert.equal(d.proposeLocation({ merchantId, addressOriginal: "Trần Phú", lat: 12.2451, lng: 109.1943, coordinatesFrom: "source", evidence: el(0), capturedAt: "2026-09-20" }).outcome, "published");
  d.proposeLocation({ merchantId, addressOriginal: "12 Trần Phú", evidence: q(src.dir, "Địa chỉ: 12 Trần Phú."), capturedAt: "2026-09-20" });
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM kb_source_conflicts WHERE subject_type = 'location'`).get().n, 1);
});

test("RATING: per source, history kept, re-observation only moves last_seen, never on a food", () => {
  const { db, d, el, q, src } = setup();
  const { merchantId } = osmMerchant(d, el, 0);
  const r1 = d.proposeRating({ merchantId, ratingSource: "dir.example", rating: 4.5, reviewCount: 120, evidence: q(src.dir, "Đánh giá 4.5/5 từ 120 lượt"), capturedAt: "2026-09-20" });
  assert.equal(r1.outcome, "published");
  assert.equal(d.proposeRating({ merchantId, ratingSource: "dir.example", rating: 4.5, reviewCount: 120, evidence: q(src.dir, "Đánh giá 4.5/5 từ 120 lượt"), capturedAt: "2026-09-22" }).touched, true);
  const r2 = d.proposeRating({ merchantId, ratingSource: "dir.example", rating: 4.6, reviewCount: 150, evidence: q(src.dir2, "Đánh giá 4.6/5 từ 150 lượt"), capturedAt: "2026-09-25" });
  assert.equal(r2.outcome, "published");
  const history = db.prepare(`SELECT rating, review_count, captured_at, last_seen_at FROM kb_merchant_ratings ORDER BY id`).all().map((r) => ({ ...r }));
  assert.deepEqual(history, [
    { rating: 4.5, review_count: 120, captured_at: "2026-09-20", last_seen_at: "2026-09-22" },
    { rating: 4.6, review_count: 150, captured_at: "2026-09-25", last_seen_at: "2026-09-25" },
  ]);
  assert.equal(db.prepare(`SELECT rating FROM kb_v_latest_ratings WHERE merchant_id = ?`).get(merchantId).rating, 4.6);
  // a number not in the quote is refused
  assert.equal(d.proposeRating({ merchantId, ratingSource: "dir.example", rating: 4.9, evidence: q(src.dir, "Đánh giá 4.5/5 từ 120 lượt"), capturedAt: "2026-09-20" }).outcome, "review");
  assert.throws(() => d.proposeRating({ merchantId, ratingSource: "x", evidence: q(src.dir, "Đánh giá 4.5/5 từ 120 lượt"), capturedAt: "2026-09-20" }), /needs a rating/);
});

test("MENU + PRICE: products need their name in the quote; prices are parsed by the store, with history and conflicts", () => {
  const { db, d, el, q, src } = setup();
  const { merchantId } = osmMerchant(d, el, 0);
  const menu = d.proposeMenu({ merchantId, name: "Thực đơn", evidence: q(src.dir, "Bún cá - 45.000đ"), capturedAt: "2026-09-20" });
  const cat = d.category(menu.menuId, "Món chính");
  const bunCa = d.proposeProduct({ merchantId, menuId: menu.menuId, categoryId: cat, originalName: "Bún cá", evidence: q(src.dir, "Bún cá - 45.000đ"), seenAt: "2026-09-20" });
  assert.equal(bunCa.outcome, "published");
  assert.equal(d.proposeProduct({ merchantId, originalName: "Bún bò", evidence: q(src.dir, "Bún cá - 45.000đ"), seenAt: "2026-09-20" }).outcome, "review");
  const p1 = d.proposePrice({ productId: bunCa.productId, priceTextOriginal: "45.000đ", evidence: q(src.dir, "Bún cá - 45.000đ"), capturedAt: "2026-09-20" });
  assert.equal(p1.price, 45000);
  // a caller cannot slip in a price the quote does not show
  assert.equal(d.proposePrice({ productId: bunCa.productId, priceTextOriginal: "30.000đ", evidence: q(src.dir, "Bún cá - 45.000đ"), capturedAt: "2026-09-20" }).outcome, "review");
  // the same source later: new price -> history, the old row stays
  const p2 = d.proposePrice({ productId: bunCa.productId, priceTextOriginal: "50.000đ", evidence: q(src.dir2, "Bún cá - 50.000đ"), capturedAt: "2026-09-25" });
  assert.equal(p2.outcome, "published");
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM kb_product_prices WHERE product_id = ? AND status = 'published'`).get(bunCa.productId).n, 2);
  // another source disagreeing in the same window -> both kept, conflict recorded
  d.proposePrice({ productId: bunCa.productId, priceTextOriginal: "48.000đ", evidence: q(src.blog, "Bún cá - 48.000đ"), capturedAt: "2026-09-26" });
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM kb_source_conflicts WHERE subject_type = 'price'`).get().n, 1);
  // a variant is its own price, not a conflict
  const dacBiet = d.proposeProduct({ merchantId, originalName: "Bún cá đặc biệt", evidence: q(src.dir, "Bún cá đặc biệt - 55.000đ"), seenAt: "2026-09-20" });
  d.proposePrice({ productId: dacBiet.productId, priceTextOriginal: "55.000đ", evidence: q(src.dir, "Bún cá đặc biệt - 55.000đ"), capturedAt: "2026-09-20" });
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM kb_source_conflicts`).get().n, 1);
  // re-listing the same product only moves last_seen
  assert.equal(d.proposeProduct({ merchantId, originalName: "Bún cá", evidence: q(src.dir2, "Bún cá - 50.000đ"), seenAt: "2026-09-25" }).touched, true);
});

test("LINKS: exact links publish; variant/alias need a person; an 'exact' that is not exact goes to review", () => {
  const { knowledge, d, el, q, src } = setup();
  const { merchantId } = osmMerchant(d, el, 0);
  knowledge.proposeEntity({ key: "bun-ca", canonicalName: "Bún cá", evidence: q(src.dir, "Bún cá - 45.000đ") });
  const bunCa = d.proposeProduct({ merchantId, originalName: "Bún cá", evidence: q(src.dir, "Bún cá - 45.000đ"), seenAt: "2026-09-20" });
  const dacBiet = d.proposeProduct({ merchantId, originalName: "Bún cá đặc biệt", evidence: q(src.dir, "Bún cá đặc biệt - 55.000đ"), seenAt: "2026-09-20" });
  assert.equal(d.proposeFoodProductLink({ foodKey: "bun-ca", kbProductId: bunCa.productId, matchType: "exact" }).outcome, "published");
  const lying = d.proposeFoodProductLink({ foodKey: "bun-ca", kbProductId: dacBiet.productId, matchType: "exact" });
  assert.equal(lying.outcome, "review");
  assert.equal(lying.reasons[0].code, "NOT_EXACT");
  const approved = d.resolveLinkReview({ linkId: lying.linkId, approve: true, decidedBy: "founder" });
  assert.equal(approved.status, "published");
  assert.throws(() => d.proposeFoodProductLink({ foodKey: "bun-ca", platformMerchantId: "ATIEU001", platformProductId: 3, matchType: "manual" }), /decidedBy/);
  assert.equal(d.proposeFoodProductLink({ foodKey: "bun-ca", platformMerchantId: "ATIEU001", platformProductId: 3, matchType: "manual", decidedBy: "founder" }).outcome, "published");
  assert.equal(d.proposeFoodProductLink({ foodKey: "bun-ca", kbProductId: bunCa.productId, matchType: "exact" }).reasons[0].code, "ALREADY_EXISTS");
  const bridge = d.bridgeMerchant({ kbMerchantId: merchantId, platformMerchantId: "DEMO_X", linkedBy: "founder" });
  assert.equal(bridge.platform_merchant_id, "DEMO_X");
});
