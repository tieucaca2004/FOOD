// A Tiểu (ATIEU001) as a generic merchant: its catalog import, the seed's
// idempotency and engine choice, and the generic matching rules checked
// against the real A Tiểu catalog. Expected values come from the source
// snapshot (platform/db/catalog/atieu_menu.json) — never re-typed menus.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createPlatformConnection, runPlatformMigrations } from "../../db/connection.js";
import { runPlatformSeed } from "../../db/seed.js";
import { runAtieuCatalogSeed, loadAtieuCatalog, ATIEU_MERCHANT_ID } from "../../db/atieuCatalogSeed.js";
import { matchByName, matchCategories, resolveItemRequest } from "../../nlp/genericOrderText.js";
import { understandMessage } from "../../conversation/understand.js";

const SOURCE = JSON.parse(fs.readFileSync(new URL("../../db/catalog/atieu_menu.json", import.meta.url), "utf8"));

const CATEGORIES = [
  "HỦ TIẾU XÀO",
  "MÌ XÀO GIÒN",
  "MÌ XÀO MỀM",
  "PHỞ CHIÊN GIÒN",
  "MIẾN",
  "CƠM CÁNH GÀ",
  "CƠM XÀO",
  "CƠM CHIÊN",
  "CƠM CHÁY",
  "MÓN NƯỚC",
  "MÓN PHỤ",
  "GỌI THÊM",
  "NƯỚC UỐNG",
];

function freshDb() {
  const db = createPlatformConnection(":memory:");
  runPlatformMigrations(db);
  return db;
}

function catalogRows(db) {
  return db
    .prepare(
      `SELECT p.id, p.sku, p.name, p.price, p.description, p.image_url, p.available, p.sort_order, c.name AS category
       FROM merchant_products p LEFT JOIN merchant_categories c ON c.id = p.category_id
       WHERE p.merchant_id = ? ORDER BY p.sort_order`
    )
    .all(ATIEU_MERCHANT_ID);
}

// Products as the engine sees them: with their category name.
function enginePool() {
  const db = freshDb();
  runPlatformSeed(db, { atieuEngine: "generic" });
  return catalogRows(db).map((r) => ({ id: r.id, name: r.name, price: r.price, category: r.category }));
}

// --- CATALOG ------------------------------------------------------------------------

test("CATALOG: the source snapshot is the supplied 76-product A Tiểu menu", () => {
  assert.equal(SOURCE.item_count, 76);
  assert.equal(SOURCE.items.length, 76);
  assert.equal(loadAtieuCatalog().items.length, 76);
  assert.deepEqual([...new Set(SOURCE.items.map((p) => p.category))], CATEGORIES);
});

test("CATALOG: generic seed imports exactly the 76 source products — names, prices, categories, order", () => {
  const db = freshDb();
  runPlatformSeed(db, { atieuEngine: "generic" });
  const rows = catalogRows(db);
  assert.equal(rows.length, 76);
  SOURCE.items.forEach((src, i) => {
    const row = rows[i];
    assert.equal(row.name, src.name);
    assert.equal(row.price, src.price_vnd, src.name);
    assert.equal(row.category, src.category, src.name);
    assert.equal(row.description, src.description || null, src.name);
    assert.equal(row.image_url, src.image_file || null, src.name);
    assert.equal(row.available, 1);
    assert.equal(row.sort_order, i + 1);
  });
  const cats = db.prepare(`SELECT name FROM merchant_categories WHERE merchant_id = ? ORDER BY sort_order`).all(ATIEU_MERCHANT_ID);
  assert.deepEqual(cats.map((c) => c.name), CATEGORIES);
  assert.equal(db.prepare(`SELECT status FROM merchant_menus WHERE merchant_id = ?`).get(ATIEU_MERCHANT_ID).status, "PUBLISHED");
  // spot checks straight from the menu
  const price = (name) => rows.find((r) => r.name === name).price;
  assert.equal(price("HỦ TIẾU XÀO HẢI SẢN"), 75000);
  assert.equal(price("THÊM TÔM"), 50000);
  assert.equal(price("THÊM BÒ"), 35000);
  assert.equal(price("THÊM MỰC"), 40000);
  assert.equal(price("THÊM CẬT"), 30000);
  assert.equal(price("TRỨNG ỐP LA"), 9000);
  assert.equal(price("THÊM CUA"), 60000);
  // no invented search data
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM merchant_products WHERE merchant_id = ? AND keywords_json != '[]'`).get(ATIEU_MERCHANT_ID).n, 0);
});

test("SEED: idempotent — re-running never duplicates products or categories and keeps product ids", () => {
  const db = freshDb();
  runPlatformSeed(db, { atieuEngine: "generic" });
  const firstIds = catalogRows(db).map((r) => r.id);
  runPlatformSeed(db, { atieuEngine: "generic" });
  runAtieuCatalogSeed(db);
  runAtieuCatalogSeed(db);
  const rows = catalogRows(db);
  assert.equal(rows.length, 76);
  assert.deepEqual(rows.map((r) => r.id), firstIds);
  assert.equal(new Set(rows.map((r) => r.name)).size, 76);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM merchant_categories WHERE merchant_id = ?`).get(ATIEU_MERCHANT_ID).n, 13);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM merchant_menus WHERE merchant_id = ?`).get(ATIEU_MERCHANT_ID).n, 1);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM merchants WHERE merchant_id = ?`).get(ATIEU_MERCHANT_ID).n, 1);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM merchant_subscriptions WHERE merchant_id = ?`).get(ATIEU_MERCHANT_ID).n, 1);
});

test("SEED: a product dropped from the source is hidden, not deleted; restoring it reuses the same row", () => {
  const db = freshDb();
  runPlatformSeed(db, { atieuEngine: "generic" });
  const shorter = { ...SOURCE, item_count: 75, items: SOURCE.items.slice(0, 75) };
  runAtieuCatalogSeed(db, shorter);
  const last = db.prepare(`SELECT id, available FROM merchant_products WHERE merchant_id = ? AND name = ?`).get(ATIEU_MERCHANT_ID, "TRÀ Ô LONG");
  assert.equal(last.available, 0);
  runAtieuCatalogSeed(db);
  assert.equal(catalogRows(db).filter((r) => r.available === 1).length, 76);
  assert.equal(db.prepare(`SELECT id FROM merchant_products WHERE merchant_id = ? AND name = ?`).get(ATIEU_MERCHANT_ID, "TRÀ Ô LONG").id, last.id);
});

test("SEED: the engine is an explicit choice — legacy stays the default, generic is opt-in and reversible", () => {
  const db = freshDb();
  const moduleOf = () => db.prepare(`SELECT module FROM merchants WHERE merchant_id = ?`).get(ATIEU_MERCHANT_ID).module;
  runPlatformSeed(db, { atieuEngine: "legacy" });
  assert.equal(moduleOf(), "atieu");
  assert.equal(catalogRows(db).length, 0); // legacy boot imports nothing
  runPlatformSeed(db, { atieuEngine: "generic" });
  assert.equal(moduleOf(), "generic");
  assert.equal(catalogRows(db).length, 76);
  runPlatformSeed(db, { atieuEngine: "legacy" });
  assert.equal(moduleOf(), "atieu");
  assert.equal(catalogRows(db).length, 76); // catalog kept, just not routed
});

test("SEED: the catalog import refuses to run before ATIEU001 exists", () => {
  assert.throws(() => runAtieuCatalogSeed(freshDb()), /not registered/);
});

// --- SEARCH (matching on the real catalog) ----------------------------------------------

test("SEARCH: natural phrases resolve to the one plain dish they name", () => {
  const pool = enginePool();
  const resolve = (text) => resolveItemRequest(text, pool);
  const cases = {
    "cho tôi hủ tiếu hải sản": "HỦ TIẾU XÀO HẢI SẢN",
    "hủ tiếu bò": "HỦ TIẾU XÀO BÒ",
    "hủ tiếu thập cẩm": "HỦ TIẾU XÀO THẬP CẨM",
    "mì giòn hải sản": "MÌ XÀO GIÒN HẢI SẢN",
    "mì mềm bò": "MÌ XÀO MỀM BÒ",
    "phở chiên hải sản": "PHỞ CHIÊN GIÒN HẢI SẢN",
    "cơm chiên cua": "CƠM CHIÊN CUA",
    "HỦ TIẾU XÀO HẢI SẢN": "HỦ TIẾU XÀO HẢI SẢN",
    "hủ tiếu hải sản đặc biệt": "HỦ TIẾU XÀO HẢI SẢN ĐẶC BIỆT",
    "mì mềm cánh gà": "MÌ XÀO CÁNH GÀ HONG KONG", // "mềm" comes from the category
  };
  for (const [text, name] of Object.entries(cases)) assert.equal(resolve(text).match?.name, name, text);
});

test("SEARCH: quantity, accents, case, whitespace and punctuation", () => {
  const pool = enginePool();
  for (const text of ["2 hủ tiếu hải sản", "cho 2 phần hủ tiếu hải sản", "2 hu tieu hai san", "CHO 2 HU TIEU HAI SAN", "  cho   2  hủ tiếu,  hải sản!!! "]) {
    const r = resolveItemRequest(text, pool);
    assert.equal(r.quantity, 2, text);
    assert.equal(r.match?.name, "HỦ TIẾU XÀO HẢI SẢN", text);
  }
});

test("ADD-ON: 'thêm …' names the GỌI THÊM product, price from the catalog", () => {
  const pool = enginePool();
  const cases = { "thêm tôm": "THÊM TÔM", "thêm bò": "THÊM BÒ", "thêm mực": "THÊM MỰC", "thêm cật": "THÊM CẬT", "thêm cua": "THÊM CUA", "thêm trứng": "TRỨNG ỐP LA" };
  for (const [text, name] of Object.entries(cases)) {
    const r = resolveItemRequest(text, pool);
    assert.equal(r.match?.name, name, text);
    assert.equal(r.match.price, SOURCE.items.find((p) => p.name === name).price_vnd);
  }
  assert.equal(resolveItemRequest("thêm 2 tôm", pool).quantity, 2);
  assert.equal(resolveItemRequest("thêm 2 tôm", pool).match?.name, "THÊM TÔM");
  // a real "thêm <quantity> <dish>" keeps meaning the dish
  assert.equal(resolveItemRequest("thêm 1 cơm chiên cua", pool).match?.name, "CƠM CHIÊN CUA");
});

test("AMBIGUITY: phrases naming several dishes are never settled by the matcher", () => {
  const pool = enginePool();
  const names = (q) => matchByName(q, pool).candidates.map((c) => c.name);
  const noMatch = (q) => assert.equal(matchByName(q, pool).match, null, q);

  noMatch("thap cam");
  for (const n of ["HỦ TIẾU XÀO THẬP CẨM", "MÌ XÀO GIÒN THẬP CẨM", "MÌ XÀO MỀM THẬP CẨM", "PHỞ CHIÊN GIÒN THẬP CẨM", "MIẾN THẬP CẨM", "CƠM CHÁY SỐT THẬP CẨM"]) {
    assert.ok(names("thap cam").includes(n), n);
  }
  noMatch("com hai san");
  assert.deepEqual(names("com hai san"), ["CƠM XÀO HẢI SẢN", "CƠM CHIÊN HẢI SẢN", "CƠM CHÁY HẢI SẢN"]);
  noMatch("sui cao");
  assert.ok(names("sui cao").length >= 6);
  noMatch("sting");
  assert.deepEqual(names("sting"), ["REVIVE / FANTA / STING", "STING DÂU"]);
  noMatch("hu tieu");
  noMatch("tom");
  noMatch("trung");
});

test("AMBIGUITY: the plain-dish rule never breaks a tie between dishes sharing the same text", () => {
  const items = [
    { id: 1, name: "Pizza Thập Cẩm Thịt 28cm" },
    { id: 2, name: "Meatlover Pizza - Pizza Thập Cẩm Thịt 28cm" },
  ];
  assert.equal(matchByName("pizza thap cam", items).match, null);
  assert.equal(matchByName("pizza thap cam thit 28cm", items).match, null);
});

test("SEARCH: item segments — 'hải sản' is not the number 'hai'; a leading 'thêm' stays with its item", () => {
  const items = (t) => understandMessage(t).items;
  assert.deepEqual(items("cho 2 hủ tiếu, hải sản"), ["cho 2 hủ tiếu, hải sản"]);
  assert.deepEqual(items("cho 2 mì, nấm đông cô"), ["cho 2 mì, nấm đông cô"]);
  assert.deepEqual(items("cho 2 tôm, hai bò viên"), ["cho 2 tôm", "hai bò viên"]);
  assert.deepEqual(items("cho 2 tom, hai bo vien"), ["cho 2 tom", "hai bo vien"]); // unaccented: still a number
  assert.deepEqual(items("thêm 2 tôm"), ["thêm 2 tôm"]);
  assert.deepEqual(items("cho 2 hủ tiếu hải sản thêm 1 cơm chiên cua"), ["cho 2 hủ tiếu hải sản", "1 cơm chiên cua"]);
});

// --- MENU / understanding ------------------------------------------------------------

test("MENU: menu requests and category browsing are understood", () => {
  for (const text of ["menu", "thực đơn", "quán có gì", "có món gì", "cho xem menu", "xem thực đơn"]) {
    assert.equal(understandMessage(text).intent, "show_menu", text);
  }
  assert.deepEqual(
    ["cho xem hủ tiếu", "cho tôi xem cơm", "cho xem món nước", "xem mì nha"].map((t) => [understandMessage(t).intent, understandMessage(t).query]),
    [
      ["browse_category", "hu tieu"],
      ["browse_category", "com"],
      ["browse_category", "mon nuoc"],
      ["browse_category", "mi"],
    ]
  );
  // cart views stay cart views
  assert.equal(understandMessage("xem giỏ").intent, "show_cart");
  assert.equal(understandMessage("xem lại").intent, "review_order");
});

test("MENU: category browsing names categories by their words", () => {
  const categories = CATEGORIES.map((name) => ({ name }));
  const found = (q) => matchCategories(q, categories).map((c) => c.name);
  assert.deepEqual(found("hu tieu"), ["HỦ TIẾU XÀO"]);
  assert.deepEqual(found("com"), ["CƠM CÁNH GÀ", "CƠM XÀO", "CƠM CHIÊN", "CƠM CHÁY"]);
  assert.deepEqual(found("mon nuoc"), ["MÓN NƯỚC"]);
  assert.deepEqual(found("cac mon com chay"), ["CƠM CHÁY"]);
  assert.deepEqual(found("pizza"), []);
});
