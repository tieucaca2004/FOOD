// Food Intelligence P0 update — Food ↔ Merchant discovery schema (knowledge
// migration 002). Rows below are SYNTHETIC TEST FIXTURES inserted with SQL
// (merchants "Quán A…D" are made up); the point is the SHAPE of the model:
// many-to-many links, ownership of price/rating, provenance, constraints.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createKnowledgeConnection, runKnowledgeMigrations } from "../../knowledge/db.js";

function setup() {
  const db = createKnowledgeConnection(":memory:");
  runKnowledgeMigrations(db);
  const ins = (sql, ...params) => db.prepare(sql).run(...params).lastInsertRowid;
  const source = ins(
    `INSERT INTO kb_sources (url, domain, source_type, fetched_at, content_type, content_hash, raw_path) VALUES ('https://dir.example/x', 'dir.example', 'directory', '2026-09-20', 'text/html', 'h1', 'raw/x.html')`
  );
  const ev = (quote = "fixture quote") => ins(`INSERT INTO kb_evidence (source_id, quote, extraction, verification) VALUES (?, ?, 'explicit', 'verified')`, source, quote);
  const food = (key, name) => ins(`INSERT INTO kb_food_entities (key, canonical_name, normalized_name, status) VALUES (?, ?, ?, 'published')`, key, name, key.replace(/-/g, " "));
  const merchant = (key, name, status = "verified") =>
    ins(`INSERT INTO kb_merchants (key, name, normalized_name, status, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, '2026-09-20', '2026-09-20')`, key, name, key, status);
  const product = (merchantId, name, extra = {}) =>
    ins(
      `INSERT INTO kb_merchant_products (merchant_id, original_name, normalized_name, availability, evidence_id, status, first_seen_at, last_seen_at, category_id)
       VALUES (?, ?, ?, ?, ?, 'published', '2026-09-20', ?, ?)`,
      merchantId, name, name.toLowerCase(), extra.availability ?? "active", ev(name), extra.lastSeen ?? "2026-09-20", extra.categoryId ?? null
    );
  const link = (foodId, productId, extra = {}) =>
    ins(
      `INSERT INTO kb_food_product_links (food_entity_id, kb_product_id, match_type, link_role, evidence_id, status, decided_by) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      foodId, productId, extra.matchType ?? "exact", extra.role ?? "primary", ev(), extra.status ?? "published", extra.decidedBy ?? null
    );
  const price = (productId, value, capturedAt, extra = {}) =>
    ins(
      `INSERT INTO kb_product_prices (product_id, variant, price, price_text_original, evidence_id, captured_at, last_seen_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'published')`,
      productId, extra.variant ?? null, value, extra.text ?? String(value), ev(), capturedAt, capturedAt
    );
  return { db, ins, ev, food, merchant, product, link, price };
}

test("SCHEMA: migration 002 adds the discovery tables to knowledge.db only (all kb_, no platform tables)", () => {
  const { db } = setup();
  const names = db.prepare(`SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%'`).all().map((r) => r.name);
  for (const t of [
    "kb_merchants", "kb_merchant_claims", "kb_merchant_locations", "kb_merchant_ratings", "kb_merchant_links", "kb_duplicate_candidates",
    "kb_menus", "kb_menu_categories", "kb_merchant_products", "kb_product_prices", "kb_food_product_links", "kb_food_review_signals",
    "kb_v_food_merchant_products", "kb_v_merchant_foods", "kb_v_merchant_menu_stats", "kb_v_latest_prices", "kb_v_latest_ratings",
  ]) {
    assert.ok(names.includes(t), t);
  }
  for (const n of names) assert.match(n, /^kb_/, n);
  assert.ok(!names.includes("merchant_products"));
  assert.ok(db.prepare(`SELECT name FROM kb_schema_migrations`).all().some((r) => r.name === "002_merchant_discovery.sql"));
});

test("MANY-TO-MANY: one food at many merchants, one merchant with many foods, a combo linked to two foods", () => {
  const { db, food, merchant, product, link } = setup();
  const bunCa = food("bun-ca", "Bún cá");
  const bunSua = food("bun-sua", "Bún sứa");
  const nem = food("nem-nuong", "Nem nướng");
  const [a, b, c, d] = ["quan-a", "quan-b", "quan-c", "quan-d"].map((k, i) => merchant(k, `Quán ${"ABCD"[i]}`));
  for (const m of [a, b, c, d]) link(bunCa, product(m, "Bún cá"));
  link(bunSua, product(a, "Bún sứa"));
  link(nem, product(a, "Nem nướng"));
  const combo = product(b, "Combo bún cá + nem");
  link(bunCa, combo, { role: "component" });
  link(nem, combo, { role: "component" });

  const sellers = db.prepare(`SELECT DISTINCT merchant_name FROM kb_v_food_merchant_products WHERE food_key = 'bun-ca' ORDER BY merchant_name`).all().map((r) => r.merchant_name);
  assert.deepEqual(sellers, ["Quán A", "Quán B", "Quán C", "Quán D"]);
  const aFoods = db.prepare(`SELECT DISTINCT food_key FROM kb_v_merchant_foods WHERE kb_merchant_id = ? ORDER BY food_key`).all(a).map((r) => r.food_key);
  assert.deepEqual(aFoods, ["bun-ca", "bun-sua", "nem-nuong"]);
  // "quán nào bán bún cá VÀ nem nướng?"
  const both = db
    .prepare(`SELECT kb_merchant_id FROM kb_v_merchant_foods WHERE food_key IN ('bun-ca','nem-nuong') GROUP BY kb_merchant_id HAVING COUNT(DISTINCT food_key) = 2 ORDER BY kb_merchant_id`)
    .all()
    .map((r) => r.kb_merchant_id);
  assert.deepEqual(both, [a, b]);
  // the combo is ONE product linked to two foods, not duplicated
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM kb_merchant_products WHERE original_name LIKE 'Combo%'`).get().n, 1);
});

test("MENU STATS: 'quán nào có nhiều món' counts published, not-inactive listings", () => {
  const { db, food, merchant, product, link, ins, ev } = setup();
  const big = merchant("quan-lon", "Quán Lớn");
  const small = merchant("quan-nho", "Quán Nhỏ");
  const menu = ins(`INSERT INTO kb_menus (merchant_id, evidence_id, captured_at, last_seen_at) VALUES (?, ?, '2026-09-20', '2026-09-20')`, big, ev());
  const cat1 = ins(`INSERT INTO kb_menu_categories (menu_id, name) VALUES (?, 'Món chính')`, menu);
  const cat2 = ins(`INSERT INTO kb_menu_categories (menu_id, name) VALUES (?, 'Đồ uống')`, menu);
  const bunCa = food("bun-ca", "Bún cá");
  link(bunCa, product(big, "Bún cá", { categoryId: cat1 }));
  product(big, "Bún sứa", { categoryId: cat1 });
  product(big, "Trà đá", { categoryId: cat2 });
  product(big, "Món cũ", { availability: "inactive" });
  product(small, "Bún cá");
  const stats = Object.fromEntries(db.prepare(`SELECT * FROM kb_v_merchant_menu_stats`).all().map((r) => [r.merchant_name, r]));
  assert.equal(stats["Quán Lớn"].product_count, 3);
  assert.equal(stats["Quán Lớn"].category_count, 2);
  assert.equal(stats["Quán Lớn"].food_count, 1);
  assert.equal(stats["Quán Nhỏ"].product_count, 1);
  assert.equal(stats["Quán Lớn"].menu_last_seen_at, "2026-09-20");
});

test("PRICE: owned by each merchant's product (never by a food); variants, ranges, missing prices, history", () => {
  const { db, food, merchant, product, link, price } = setup();
  const foodCols = db.prepare(`PRAGMA table_info(kb_food_entities)`).all().map((c) => c.name);
  assert.ok(!foodCols.some((c) => /price|rating/.test(c)), "a food entity has no price or rating");
  const bunCa = food("bun-ca", "Bún cá");
  const pa = product(merchant("quan-a", "Quán A"), "Bún cá");
  const pb = product(merchant("quan-b", "Quán B"), "Bún cá");
  const pc = product(merchant("quan-c", "Quán C"), "Bún cá");
  [pa, pb, pc].forEach((p) => link(bunCa, p));
  price(pa, 40000, "2026-09-01", { text: "40K" });
  price(pb, 45000, "2026-09-02");
  price(pc, 55000, "2026-03-01"); // old observation stays old
  price(pa, 42000, "2026-09-20", { text: "42.000đ" }); // newer observation, history kept
  price(pb, 60000, "2026-09-02", { variant: "đặc biệt" });

  const latest = db
    .prepare(
      `SELECT v.merchant_name, p.price, p.variant, p.captured_at FROM kb_v_food_merchant_products v
       JOIN kb_v_latest_prices p ON p.product_id = v.kb_product_id WHERE v.food_key = 'bun-ca' ORDER BY p.price`
    )
    .all()
    .map((r) => [r.merchant_name, r.price, r.variant, r.captured_at]);
  assert.deepEqual(latest, [
    ["Quán A", 42000, null, "2026-09-20"],
    ["Quán B", 45000, null, "2026-09-02"],
    ["Quán C", 55000, null, "2026-03-01"],
    ["Quán B", 60000, "đặc biệt", "2026-09-02"],
  ]);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM kb_product_prices WHERE product_id = ?`).get(pa).n, 2); // history
  // "dưới 50k": a filter over each merchant's own latest price
  const under50 = latest.filter(([, p]) => p <= 50000).map(([m]) => m);
  assert.deepEqual(under50, ["Quán A", "Quán B"]);
  // no price in the source -> NULL price, original text kept
  price(pa, null, "2026-09-21", { text: "giá liên hệ" });
  assert.equal(db.prepare(`SELECT price_text_original FROM kb_product_prices WHERE price IS NULL`).get().price_text_original, "giá liên hệ");
  assert.throws(() => price(pa, -1, "2026-09-21"), /CHECK/);
});

test("RATING: per merchant and per rating source, nullable, bounded — never a food's rating", () => {
  const { db, merchant, ins, ev } = setup();
  const a = merchant("quan-a", "Quán A");
  const rate = (merchantId, src, rating, count, at, scale = 5) =>
    ins(
      `INSERT INTO kb_merchant_ratings (merchant_id, rating_source, rating, rating_scale, review_count, evidence_id, captured_at, last_seen_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'published')`,
      merchantId, src, rating, scale, count, ev(), at, at
    );
  rate(a, "maps", 4.5, 120, "2026-08-01");
  rate(a, "maps", 4.6, 150, "2026-09-20");
  rate(a, "directory", 8.2, null, "2026-09-10", 10); // another source, another scale, no count
  const latest = db.prepare(`SELECT rating_source, rating, rating_scale, review_count FROM kb_v_latest_ratings WHERE merchant_id = ? ORDER BY rating_source`).all(a);
  assert.deepEqual(latest.map((r) => ({ ...r })), [
    { rating_source: "directory", rating: 8.2, rating_scale: 10, review_count: null },
    { rating_source: "maps", rating: 4.6, rating_scale: 5, review_count: 150 },
  ]);
  assert.throws(() => rate(a, "maps", 6, 1, "2026-09-21"), /CHECK/); // above its scale
  assert.throws(() => rate(a, "maps", null, null, "2026-09-21"), /CHECK/); // an empty rating row says nothing
  assert.throws(() => rate(a, "maps", 4, -5, "2026-09-21"), /CHECK/);
  // a dish-level opinion is a separate signal with its own source and time
  const cols = db.prepare(`PRAGMA table_info(kb_food_review_signals)`).all().map((c) => c.name);
  for (const c of ["signal_text", "evidence_id", "captured_at"]) assert.ok(cols.includes(c), c);
});

test("LINKS: exactly one target; alias/variant/semantic links need a reviewer to publish; manual needs a person", () => {
  const { db, food, merchant, product, ins, ev } = setup();
  const f = food("bun-ca", "Bún cá");
  const p = product(merchant("quan-a", "Quán A"), "Bún cá đặc biệt");
  const q = (sql, ...args) => () => ins(sql, ...args);
  // neither / both targets
  assert.throws(q(`INSERT INTO kb_food_product_links (food_entity_id, match_type, evidence_id) VALUES (?, 'exact', ?)`, f, ev()), /CHECK/);
  assert.throws(q(`INSERT INTO kb_food_product_links (food_entity_id, kb_product_id, platform_merchant_id, platform_product_id, match_type, evidence_id) VALUES (?, ?, 'M1', 7, 'exact', ?)`, f, p, ev()), /CHECK/);
  // a "names look alike" link cannot be published by a machine…
  assert.throws(q(`INSERT INTO kb_food_product_links (food_entity_id, kb_product_id, match_type, evidence_id, status) VALUES (?, ?, 'semantic', ?, 'published')`, f, p, ev()), /CHECK/);
  // …it waits in review, and publishes once someone decided
  const id = ins(`INSERT INTO kb_food_product_links (food_entity_id, kb_product_id, match_type, evidence_id, status) VALUES (?, ?, 'variant', ?, 'review')`, f, p, ev());
  db.prepare(`UPDATE kb_food_product_links SET status = 'published', decided_by = 'founder' WHERE id = ?`).run(id);
  // manual links name the person; machine links carry evidence
  assert.throws(q(`INSERT INTO kb_food_product_links (food_entity_id, platform_merchant_id, platform_product_id, match_type) VALUES (?, 'ATIEU001', 1, 'manual')`, f), /CHECK/);
  assert.throws(q(`INSERT INTO kb_food_product_links (food_entity_id, platform_merchant_id, platform_product_id, match_type) VALUES (?, 'ATIEU001', 1, 'exact')`, f), /CHECK/);
  // one link per food × product
  assert.throws(q(`INSERT INTO kb_food_product_links (food_entity_id, kb_product_id, match_type, evidence_id, status, decided_by) VALUES (?, ?, 'manual', NULL, 'published', 'founder')`, f, p), /UNIQUE/);
});

test("DISCOVERY ≠ ORDERING: orderable only through a person-made bridge to the platform, by id", () => {
  const { db, food, merchant, product, link, ins } = setup();
  const f = food("hu-tieu-xao-hai-san", "Hủ tiếu xào hải sản");
  const ref = merchant("quan-tham-khao", "Quán Tham Khảo");
  link(f, product(ref, "Hủ tiếu xào hải sản"));
  const bridged = merchant("a-tieu", "Hủ Tiếu Xào A Tiểu");
  link(f, product(bridged, "HỦ TIẾU XÀO HẢI SẢN"));
  ins(`INSERT INTO kb_merchant_links (kb_merchant_id, platform_merchant_id, linked_by) VALUES (?, 'ATIEU001', 'founder')`, bridged);
  // a direct link to an orderable platform product (ids only; the platform catalog stays the authority)
  ins(`INSERT INTO kb_food_product_links (food_entity_id, platform_merchant_id, platform_product_id, match_type, decided_by, status) VALUES (?, 'ATIEU001', 1, 'manual', 'founder', 'published')`, f);

  const rows = db.prepare(`SELECT merchant_name, bridged_platform_merchant_id, platform_product_id FROM kb_v_food_merchant_products WHERE food_entity_id = ? ORDER BY link_id`).all(f);
  assert.deepEqual(rows.map((r) => ({ ...r })), [
    { merchant_name: "Quán Tham Khảo", bridged_platform_merchant_id: null, platform_product_id: null }, // reference only
    { merchant_name: "Hủ Tiếu Xào A Tiểu", bridged_platform_merchant_id: "ATIEU001", platform_product_id: null },
    { merchant_name: null, bridged_platform_merchant_id: null, platform_product_id: 1 },
  ]);
  // one platform merchant per reference merchant, and vice versa
  assert.throws(() => ins(`INSERT INTO kb_merchant_links (kb_merchant_id, platform_merchant_id, linked_by) VALUES (?, 'OTHER', 'x')`, bridged), /UNIQUE/);
  assert.throws(() => ins(`INSERT INTO kb_merchant_links (kb_merchant_id, platform_merchant_id, linked_by) VALUES (?, 'ATIEU001', 'x')`, ref), /UNIQUE/);
  assert.throws(() => ins(`INSERT INTO kb_merchant_links (kb_merchant_id, platform_merchant_id) VALUES (?, 'X2')`, ref), /NOT NULL/);
});

test("PROVENANCE + FRESHNESS: every merchant fact needs evidence and carries captured/last-seen times", () => {
  const { db, merchant, ins } = setup();
  const a = merchant("quan-a", "Quán A");
  assert.throws(() => ins(`INSERT INTO kb_merchant_claims (merchant_id, field, original_text, captured_at, last_seen_at) VALUES (?, 'opening_hours', '6h-10h', '2026-09-20', '2026-09-20')`, a), /NOT NULL/);
  assert.throws(() => ins(`INSERT INTO kb_merchant_locations (merchant_id, address_original, captured_at, last_seen_at) VALUES (?, '12 Trần Phú', '2026-09-20', '2026-09-20')`, a), /NOT NULL/);
  assert.throws(() => ins(`INSERT INTO kb_merchant_claims (merchant_id, field, original_text, evidence_id, captured_at, last_seen_at) VALUES (?, 'best_dish', 'x', 1, 'a', 'a')`, a), /CHECK/);
  for (const table of ["kb_merchant_claims", "kb_merchant_locations", "kb_merchant_ratings", "kb_product_prices", "kb_menus"]) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    for (const c of ["evidence_id", "captured_at", "last_seen_at"]) assert.ok(cols.includes(c), `${table}.${c}`);
  }
  for (const table of ["kb_merchants", "kb_merchant_products"]) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    for (const c of ["first_seen_at", "last_seen_at"]) assert.ok(cols.includes(c), `${table}.${c}`);
  }
});

test("LOCATION: coordinates optional but never half-given; unknown coordinates stay NULL", () => {
  const { merchant, ins, ev } = setup();
  const a = merchant("quan-a", "Quán A");
  const loc = (lat, lng, from) =>
    ins(`INSERT INTO kb_merchant_locations (merchant_id, address_original, latitude, longitude, coordinates_from, evidence_id, captured_at, last_seen_at) VALUES (?, '12 Trần Phú', ?, ?, ?, ?, 'x', 'x')`, a, lat, lng, from, ev());
  loc(null, null, null); // address only
  loc(12.24, 109.19, "source");
  assert.throws(() => loc(12.24, null, "source"), /CHECK/);
  assert.throws(() => loc(12.24, 109.19, null), /CHECK/); // where the coordinates came from is required
  assert.throws(() => loc(123, 109.19, "source"), /CHECK/);
});

test("DEDUP: possible duplicates are recorded as a pair and need a decision by a person", () => {
  const { merchant, ins } = setup();
  const a = merchant("quan-a-1", "Quán A");
  const b = merchant("quan-a-2", "Quán A");
  ins(`INSERT INTO kb_duplicate_candidates (merchant_a, merchant_b, signals_json, score) VALUES (?, ?, '{"name":"same","distance_m":30}', 0.6)`, a, b);
  assert.throws(() => ins(`INSERT INTO kb_duplicate_candidates (merchant_a, merchant_b, signals_json) VALUES (?, ?, '{}')`, b, a), /CHECK/); // ordered pair
  assert.throws(() => ins(`INSERT INTO kb_duplicate_candidates (merchant_a, merchant_b, signals_json, status) VALUES (?, ?, '{}', 'merged')`, a, merchant("quan-a-3", "Quán A")), /CHECK/); // decided_by required
  assert.throws(() => ins(`INSERT INTO kb_merchants (key, name, normalized_name, status, first_seen_at, last_seen_at) VALUES ('dup', 'Quán A', 'quan a', 'duplicate', 'x', 'x')`), /CHECK/); // duplicate of whom?
});
