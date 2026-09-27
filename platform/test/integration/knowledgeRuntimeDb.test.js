// The platform reads Food Knowledge from ONE runtime DB (platformConfig.knowledgeDbPath,
// default ./data/knowledge/knowledge.db). The collector writes its own working DB and a
// verified `promote` puts a snapshot there. Rows are SYNTHETIC TEST FIXTURES.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createKnowledgeConnection, runKnowledgeMigrations } from "../../knowledge/db.js";
import { createFoodKnowledge } from "../../services/foodKnowledgeAdapter.js";
import { promoteKnowledge } from "../../../tools/knowledge-collector/lib/promote.js";
import { buildTestPlatform } from "../helpers/testPlatform.js";

const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), `kb-rt-${crypto.randomUUID()}-`));

function collectorDb(file) {
  const db = createKnowledgeConnection(file);
  runKnowledgeMigrations(db);
  const ins = (sql, ...p) => db.prepare(sql).run(...p).lastInsertRowid;
  const src = ins(`INSERT INTO kb_sources (url, domain, source_type, fetched_at, content_type, content_hash, raw_path) VALUES ('https://x.example/', 'x.example', 'merchant_official', '2026-09-26', 'text/html', 'h', 'raw/x')`);
  const ev = ins(`INSERT INTO kb_evidence (source_id, quote, extraction, verification) VALUES (?, 'q', 'explicit', 'verified')`, src);
  const food = ins(`INSERT INTO kb_food_entities (key, canonical_name, normalized_name, status) VALUES ('banh-can', 'Bánh căn', 'banh can', 'published')`);
  ins(`INSERT INTO kb_food_names (entity_id, name, normalized, kind, origin, status) VALUES (?, 'Bánh căn', 'banh can', 'canonical', 'sourced', 'published')`, food);
  const m = ins(`INSERT INTO kb_merchants (key, name, normalized_name, status, first_seen_at, last_seen_at) VALUES ('banh-can-x', 'Bánh căn X', 'banh can x', 'candidate', '2026-09-26', '2026-09-26')`);
  const p = ins(`INSERT INTO kb_merchant_products (merchant_id, original_name, normalized_name, evidence_id, status, first_seen_at, last_seen_at) VALUES (?, 'Bánh căn', 'banh can', ?, 'published', '2026-09-26', '2026-09-26')`, m, ev);
  ins(`INSERT INTO kb_food_product_links (food_entity_id, kb_product_id, match_type, confidence, evidence_id, status) VALUES (?, ?, 'exact', 0.9, ?, 'published')`, food, p, ev);
  return db; // left open in WAL mode, as the collector would
}

const openRuntime = (dbPath) => {
  const p = buildTestPlatform({ withAtieu: true, atieuEngine: "generic" });
  return createFoodKnowledge({ dbPath, services: p.services, isRoutable: () => true });
};

test("RUNTIME DB: default path is data/knowledge/knowledge.db, separate from the collector's working DB", async () => {
  const { platformConfig } = await import("../../config.js");
  if (process.env.KNOWLEDGE_SQLITE_PATH === undefined) assert.equal(platformConfig.knowledgeDbPath, "./data/knowledge/knowledge.db");
  assert.notEqual(path.resolve(platformConfig.knowledgeDbPath), path.resolve("data/normalized/pilot/knowledge.db"));
});

test("RUNTIME DB: a missing runtime DB fails safe (the adapter refuses; server.js then leaves discovery off)", () => {
  const missing = path.join(dir(), "none.db");
  assert.throws(() => openRuntime(missing));
  assert.equal(fs.existsSync(missing), false); // never created by the read-only open
});

test("PROMOTE: verified snapshot -> the runtime opens it and finds what the collector published; source untouched", async () => {
  const d = dir();
  const from = path.join(d, "collector.db");
  const src = collectorDb(from);
  const to = path.join(d, "knowledge", "knowledge.db");
  const m = await promoteKnowledge({ from, to });
  assert.equal(m.counts.foods, 1);
  assert.equal(m.counts.merchants, 1);
  assert.equal(m.previousBackup, null);
  assert.ok(JSON.parse(fs.readFileSync(`${to}.manifest.json`, "utf8")).sha256);
  const kb = openRuntime(to);
  assert.deepEqual(kb.search("Tìm quán bánh căn").result.merchants.map((x) => x.name), ["Bánh căn X"]);
  kb.close();

  // a second promotion keeps the previous runtime DB as a backup
  src.prepare(`UPDATE kb_merchants SET name = 'Bánh căn Y' WHERE key = 'banh-can-x'`).run();
  const m2 = await promoteKnowledge({ from, to });
  assert.ok(m2.previousBackup && fs.existsSync(m2.previousBackup));
  const kb2 = openRuntime(to);
  assert.deepEqual(kb2.search("Tìm quán bánh căn").result.merchants.map((x) => x.name), ["Bánh căn Y"]);
  kb2.close();
  src.close();
});

test("PROMOTE: refuses a non-knowledge DB and the same path", async () => {
  const d = dir();
  const bogus = path.join(d, "bogus.db");
  createKnowledgeConnection(bogus).close();
  await assert.rejects(promoteKnowledge({ from: bogus, to: path.join(d, "rt.db") }), /missing table/);
  await assert.rejects(promoteKnowledge({ from: bogus, to: bogus }), /same file/);
  assert.equal(fs.existsSync(path.join(d, "rt.db")), false);
});
