// Knowledge migration 004 (coverage expansion) + the store methods on it.
// The raw "sources" below are SYNTHETIC TEST FIXTURES written to a temp dir.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createKnowledgeConnection, runKnowledgeMigrations } from "../../knowledge/db.js";
import { KnowledgeStore } from "../../knowledge/store.js";
import { MerchantDiscoveryStore, addressKey } from "../../knowledge/discoveryStore.js";

function setup() {
  const dir = path.join(os.tmpdir(), `kb-cov-${randomUUID()}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "enc.txt"), "Hủ tiếu Nam Vang là món hủ tiếu mang tên Nam Vang. Hủ tiếu là món ăn có sợi. Bún bò Huế là món bún.", "utf8");
  fs.writeFileSync(path.join(dir, "blog-a.txt"), "1. Quán Bún Ba. Địa chỉ: 12 Trần Phú, Nha Trang.", "utf8");
  fs.writeFileSync(path.join(dir, "blog-b.txt"), "Quán Bún Ba - Địa chỉ: số 12 đường Trần Phú. Quán Bún Ba ở Vĩnh Hải: 99 Hai Tháng Tư.", "utf8");
  const db = createKnowledgeConnection(":memory:");
  runKnowledgeMigrations(db);
  const store = new KnowledgeStore({ db, rawRoot: dir });
  const discovery = new MerchantDiscoveryStore({ knowledge: store });
  const reg = (url, rawPath, sourceType) => store.registerSource({ url, sourceType, rawPath, contentType: "text/plain", fetchedAt: "2026-09-26T00:00:00Z" });
  return { db, store, discovery, enc: reg("https://wiki.example/x", "enc.txt", "encyclopedia"), blogA: reg("https://blog-a.example/top", "blog-a.txt", "blog"), blogB: reg("https://blog-b.example/top", "blog-b.txt", "blog") };
}

test("SCHEMA 004: region names, food duplicate candidates, product observation — kb_ tables only", () => {
  const { db } = setup();
  const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all().map((r) => r.name);
  assert.ok(tables.includes("kb_region_names") && tables.includes("kb_food_duplicate_candidates"));
  assert.ok(db.prepare(`PRAGMA table_info(kb_merchant_products)`).all().some((c) => c.name === "observation" && c.dflt_value === "'menu'"));
  assert.ok(db.prepare(`SELECT 1 FROM kb_schema_migrations WHERE name = '004_coverage_expansion.sql'`).get());
});

test("REGION NAMES: a region is written several ways; a region relation is supported by any of them", () => {
  const { store, enc } = setup();
  store.registerRegion({ id: "kh", name: "Campuchia", level: "country" });
  store.registerRegion({ id: "kh.phnom-penh", name: "Phnom Penh", parentId: "kh", level: "locality", names: ["Nam Vang"] });
  store.registerRegion({ id: "kh.phnom-penh", name: "Phnom Penh", parentId: "kh", level: "locality", names: ["Nam Vang"] }); // idempotent
  assert.deepEqual(store.regionNames("kh.phnom-penh"), ["Phnom Penh", "Nam Vang"]);
  store.proposeEntity({ key: "hu-tieu-nam-vang", canonicalName: "Hủ tiếu Nam Vang", evidence: { sourceId: enc.id, quote: "Hủ tiếu Nam Vang là món hủ tiếu mang tên Nam Vang.", extraction: "explicit" } });
  // the quote says "Nam Vang", not "Phnom Penh": still the same region
  const explicit = store.proposeClaim({ entityKey: "hu-tieu-nam-vang", kind: "relation", key: "regional_style", value: "kh.phnom-penh", evidence: { sourceId: enc.id, quote: "Hủ tiếu Nam Vang là món hủ tiếu mang tên Nam Vang.", extraction: "explicit" } });
  assert.equal(explicit.outcome, "published");
  // a style derived by rule is only a proposal
  store.registerRegion({ id: "vn", name: "Việt Nam", level: "country" });
  store.registerRegion({ id: "vn.hue", name: "Huế", parentId: "vn", level: "province" });
  store.proposeEntity({ key: "bun-bo-hue", canonicalName: "Bún bò Huế", evidence: { sourceId: enc.id, quote: "Bún bò Huế là món bún.", extraction: "explicit" } });
  const rule = store.proposeClaim({ entityKey: "bun-bo-hue", kind: "relation", key: "regional_style", value: "vn.hue", evidence: { sourceId: enc.id, quote: "Bún bò Huế là món bún.", extraction: "rule" } });
  assert.equal(rule.outcome, "review");
  // a region the quote does not name at all is not supported
  const wrong = store.proposeClaim({ entityKey: "bun-bo-hue", kind: "relation", key: "origin_region", value: "kh.phnom-penh", evidence: { sourceId: enc.id, quote: "Bún bò Huế là món bún.", extraction: "explicit" } });
  assert.notEqual(wrong.outcome, "published");
});

test("RE-FETCH: the same page fetched again (a new snapshot) saying the same thing adds no second claim", () => {
  const { db, store, enc } = setup();
  store.proposeEntity({ key: "hu-tieu", canonicalName: "Hủ tiếu", evidence: { sourceId: enc.id, quote: "Hủ tiếu là món ăn có sợi.", extraction: "explicit" } });
  const claim = (sourceId) => store.proposeClaim({ entityKey: "hu-tieu", kind: "facet", key: "carb_base", value: "hu_tieu", evidence: { sourceId, quote: "Hủ tiếu là món ăn có sợi.", extraction: "explicit" } });
  const first = claim(enc.id);
  // a new snapshot of the same URL (the page changed elsewhere -> a new source row)
  const raw = path.join(store.rawRoot, "enc-v2.txt");
  fs.writeFileSync(raw, "Hủ tiếu là món ăn có sợi. Một câu mới được thêm vào trang.", "utf8");
  const again = store.registerSource({ url: "https://wiki.example/x", sourceType: "encyclopedia", rawPath: "enc-v2.txt", contentType: "text/plain", fetchedAt: "2026-09-27T00:00:00Z" });
  assert.notEqual(again.id, enc.id);
  const second = claim(again.id);
  assert.equal(second.claimId, first.claimId);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM kb_claims WHERE key = 'carb_base'`).get().n, 1);
});

test("FOOD DUPLICATES: recorded once per pair, never merged; a decision needs a person", () => {
  const { db, store, enc } = setup();
  store.proposeEntity({ key: "hu-tieu", canonicalName: "Hủ tiếu", evidence: { sourceId: enc.id, quote: "Hủ tiếu là món ăn có sợi.", extraction: "explicit" } });
  store.proposeEntity({ key: "hu-tieu-nam-vang", canonicalName: "Hủ tiếu Nam Vang", evidence: { sourceId: enc.id, quote: "Hủ tiếu Nam Vang là món hủ tiếu mang tên Nam Vang.", extraction: "explicit" } });
  const [a, b] = ["hu-tieu", "hu-tieu-nam-vang"].map((k) => store.entity(k).id);
  const first = store.proposeFoodDuplicate({ entityA: b, entityB: a, kind: "name_extends", signals: { base: "hu tieu" }, score: 0.5 });
  assert.equal(first.created, true);
  assert.equal(first.row.entity_a, Math.min(a, b));
  assert.equal(store.proposeFoodDuplicate({ entityA: a, entityB: b, kind: "name_extends", signals: {} }).created, false);
  assert.equal(store.listReview().foodDuplicates.length, 1);
  assert.throws(() => db.prepare(`UPDATE kb_food_duplicate_candidates SET status = 'same_dish' WHERE id = ?`).run(first.row.id), /CHECK/);
  assert.throws(() => store.resolveFoodDuplicate({ id: first.row.id, decision: "variant" }), /decidedBy/);
  assert.equal(store.resolveFoodDuplicate({ id: first.row.id, decision: "variant", decidedBy: "founder" }).status, "variant");
  // both entities remain, untouched
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM kb_food_entities WHERE status = 'published'`).get().n, 2);
});

test("MERCHANT DEDUP: same name + same written address -> a stronger candidate (0.8), still not merged", () => {
  const { db, discovery, blogA, blogB } = setup();
  assert.equal(addressKey("số 12 đường Trần Phú"), addressKey("12 Trần Phú, Nha Trang"));
  const seen = "2026-09-26T00:00:00Z";
  const a = discovery.upsertMerchant({ name: "Quán Bún Ba", identifiers: [], address: "12 Trần Phú, Nha Trang", seenAt: seen, evidence: { sourceId: blogA.id, quote: "1. Quán Bún Ba.", extraction: "explicit" } });
  discovery.proposeLocation({ merchantId: a.merchantId, addressOriginal: "12 Trần Phú, Nha Trang", evidence: { sourceId: blogA.id, quote: "Địa chỉ: 12 Trần Phú, Nha Trang.", extraction: "explicit" }, capturedAt: seen });
  const b = discovery.upsertMerchant({ name: "Quán Bún Ba", identifiers: [], address: "số 12 đường Trần Phú", seenAt: seen, evidence: { sourceId: blogB.id, quote: "Quán Bún Ba - Địa chỉ", extraction: "explicit" } });
  assert.notEqual(a.merchantId, b.merchantId);
  const dup = db.prepare(`SELECT * FROM kb_duplicate_candidates`).get();
  assert.equal(dup.score, 0.8);
  assert.equal(JSON.parse(dup.signals_json).same_address, true);
  // same name, different address -> the plain name candidate
  discovery.proposeLocation({ merchantId: b.merchantId, addressOriginal: "số 12 đường Trần Phú", evidence: { sourceId: blogB.id, quote: "Địa chỉ: số 12 đường Trần Phú.", extraction: "explicit" }, capturedAt: seen });
  const c = discovery.upsertMerchant({ name: "Quán Bún Ba", identifiers: [], address: "99 Hai Tháng Tư", seenAt: seen, evidence: { sourceId: blogB.id, quote: "Quán Bún Ba ở Vĩnh Hải", extraction: "explicit" } });
  const forC = db.prepare(`SELECT score, signals_json FROM kb_duplicate_candidates WHERE merchant_b = ?`).all(c.merchantId);
  assert.ok(forC.length === 2 && forC.every((d) => d.score === 0.5 && JSON.parse(d.signals_json).same_address === false));
});

test("ALIAS LINKS: a product equal to a food's CANONICAL name publishes; equal only to an alias -> 'alias', review", () => {
  const { db, store, discovery, enc, blogA } = setup();
  store.proposeEntity({ key: "hu-tieu", canonicalName: "Hủ tiếu", evidence: { sourceId: enc.id, quote: "Hủ tiếu là món ăn có sợi.", extraction: "explicit" } });
  // an alias with evidence (made-up fixture): "Hủ tiếu" also written "Bún"
  db.prepare(`INSERT INTO kb_food_names (entity_id, name, normalized, kind, origin, status) VALUES (?, 'Quán Bún Ba', 'quan bun ba', 'alias', 'sourced', 'published')`).run(store.entity("hu-tieu").id);
  const seen = "2026-09-26T00:00:00Z";
  const m = discovery.upsertMerchant({ name: "Quán Bún Ba", identifiers: [], seenAt: seen, evidence: { sourceId: blogA.id, quote: "1. Quán Bún Ba.", extraction: "explicit" } });
  const byAlias = discovery.proposeProduct({ merchantId: m.merchantId, originalName: "Quán Bún Ba", observation: "mention", evidence: { sourceId: blogA.id, quote: "1. Quán Bún Ba.", extraction: "explicit" }, seenAt: seen });
  const l = discovery.proposeFoodProductLink({ foodKey: "hu-tieu", kbProductId: byAlias.productId, matchType: "exact" });
  assert.equal(l.outcome, "review");
  assert.deepEqual(l.reasons.map((r) => r.code), ["ALIAS_MATCH"]);
  assert.equal(db.prepare(`SELECT match_type FROM kb_food_product_links WHERE id = ?`).get(l.linkId).match_type, "alias");
});

test("MENTION vs MENU: a product mentioned by an article is a 'mention'; seeing it on a menu upgrades it, never the reverse", () => {
  const { db, discovery, blogA } = setup();
  const seen = "2026-09-26T00:00:00Z";
  const m = discovery.upsertMerchant({ name: "Quán Bún Ba", identifiers: [], seenAt: seen, evidence: { sourceId: blogA.id, quote: "1. Quán Bún Ba.", extraction: "explicit" } });
  const p = discovery.proposeProduct({ merchantId: m.merchantId, originalName: "Bún Ba", observation: "mention", evidence: { sourceId: blogA.id, quote: "1. Quán Bún Ba.", extraction: "explicit" }, seenAt: seen });
  const obs = () => db.prepare(`SELECT observation FROM kb_merchant_products WHERE id = ?`).get(p.productId).observation;
  assert.equal(obs(), "mention");
  discovery.proposeProduct({ merchantId: m.merchantId, originalName: "Bún Ba", evidence: { sourceId: blogA.id, quote: "1. Quán Bún Ba.", extraction: "explicit" }, seenAt: seen });
  assert.equal(obs(), "menu");
  discovery.proposeProduct({ merchantId: m.merchantId, originalName: "Bún Ba", observation: "mention", evidence: { sourceId: blogA.id, quote: "1. Quán Bún Ba.", extraction: "explicit" }, seenAt: seen });
  assert.equal(obs(), "menu");
});
