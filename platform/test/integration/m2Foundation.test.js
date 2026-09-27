// MULTIMODAL M2 FOUNDATION — the 43 checks of the M2 design dry run (data/recovery/multimodal/m2/dryrun008.mjs),
// ported to the IMPLEMENTED migration 008 and run through the REAL migration runner and the REAL promotion.
// Name mapping (founder decision 2026-09-27: the V1 build is the M2 implementation):
//   PROCESSING -> EXTRACTING · AWAITING_MERCHANT -> WAITING_FOR_MERCHANT · AWAITING_CONFIRMATION -> WAITING_FOR_CONFIRMATION
//   SUBMITTED -> CANDIDATE · digest view kb_contribution_digest_source -> kb_contribution_visible
//   stored digest table -> none: candidates are read live from the WORKING DB; promotion drops every kb_ingest_* table
// Every check keeps its original intent; none was relaxed.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createKnowledgeConnection, runKnowledgeMigrations } from "../../knowledge/db.js";
import { promoteKnowledge } from "../../../tools/knowledge-collector/lib/promote.js";

const MIG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../knowledge/migrations");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "m2-foundation-"));
const file = path.join(dir, "working.db");
const db = createKnowledgeConnection(file);

// 001–007 exactly as the runner would, then a Knowledge Group row that exists BEFORE 008
db.exec(`CREATE TABLE kb_schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))`);
for (const f of fs.readdirSync(MIG).filter((f) => f.endsWith(".sql") && f < "008").sort()) {
  db.transaction(() => {
    db.exec(fs.readFileSync(path.join(MIG, f), "utf8"));
    db.prepare(`INSERT INTO kb_schema_migrations(name) VALUES (?)`).run(f);
  })();
}
db.prepare(`INSERT INTO kb_sources (url, source_type, fetched_at, content_type, content_hash, raw_path) VALUES ('telegram://chat/-100/message/1','knowledge_group','2026-09-27','text/plain','x','ingest/a.txt')`).run();
db.prepare(`INSERT INTO kb_ingest_messages (channel, chat_id, message_id, sender_id, sender_role, text, raw_update_json, source_id) VALUES ('telegram','-100','1','42','editor','Quán A bún bò 45k','{}',1)`).run();

const throws = (fn, re) => assert.throws(fn, re);
const H = "h1:" + "a".repeat(64);
const sub = () => db.prepare(`INSERT INTO kb_ingest_submissions (channel, sender_hash, sender_hash_kid) VALUES ('telegram', ?, 'k1')`).run(H).lastInsertRowid;
let s1;
let m1;
let c1;
const custMsg = (over = {}) => {
  const m = { chat_id: H, message_id: String(Math.random()), sender_id: null, sender_display_name: null, sender_hash: H, sender_hash_kid: "k1", submission_id: s1, raw: '{"message":{"message_id":7,"photo":[{"file_id":"F"}]}}', ...over };
  return db
    .prepare(`INSERT INTO kb_ingest_messages (channel, chat_id, message_id, sender_id, sender_display_name, sender_role, raw_update_json, source_type, submission_id, sender_hash, sender_hash_kid) VALUES ('telegram', ?, ?, ?, ?, 'member', ?, 'user_contribution', ?, ?, ?)`)
    .run(m.chat_id, m.message_id, m.sender_id, m.sender_display_name, m.raw, m.submission_id, m.sender_hash, m.sender_hash_kid).lastInsertRowid;
};
const move = (to) => db.prepare(`UPDATE kb_ingest_submissions SET status = ?, expires_at = COALESCE(expires_at, datetime('now','+30 minutes')) WHERE id = ?`).run(to, s1);
const cand = (over = {}) => {
  const c = { assertion_kind: "OBSERVED", source_id: 2, quote: "Bún bò Huế 45.000đ", raw: "45.000đ", kind: "price", field: "price", ...over };
  return db
    .prepare(`INSERT INTO kb_ingest_candidates (message_id, kind, place_text, place_resolution, product_text, field, raw_value, normalized_value, change, severity, confidence, evidence_quote, source_id, assertion_kind) VALUES (?, ?, 'Quán Bà Tư', '{"status":"resolved","kbPlaceId":1186}', 'Bún bò Huế', ?, ?, '45000', 'NEW', 'LOW', 0.9, ?, ?, ?)`)
    .run(m1, c.kind, c.field, c.raw, c.quote, c.source_id, c.assertion_kind).lastInsertRowid;
};
const visible = (id) => db.prepare(`SELECT COUNT(*) AS n FROM kb_contribution_visible WHERE candidate_id = ?`).get(id).n;

// the checks run in order (they share one DB, like the dry run)
test("01 008 applies in one transaction after 001–007 (through the real runner)", () => {
  runKnowledgeMigrations(db);
  assert.ok(db.prepare(`SELECT 1 FROM kb_schema_migrations WHERE name = '008_customer_contributions.sql'`).get());
});
test("02 existing group row defaults to knowledge_group, no submission", () => {
  const r = db.prepare(`SELECT source_type, submission_id FROM kb_ingest_messages WHERE id = 1`).get();
  assert.deepEqual([r.source_type, r.submission_id], ["knowledge_group", null]);
});
test("03 group path insert unchanged (005 column list)", () => {
  db.prepare(`INSERT INTO kb_ingest_messages (channel, chat_id, message_id, sender_id, sender_display_name, sender_role, text, raw_update_json) VALUES ('telegram','-100','2','42','Ann','editor','x','{"message":{"from":{"id":42}}}')`).run();
});
test("04 group candidate insert unchanged", () => {
  db.prepare(`INSERT INTO kb_ingest_candidates (message_id, kind, place_resolution, field, raw_value, normalized_value, change, severity, confidence, evidence_quote, source_id) VALUES (1,'price','{"status":"unknown"}','price','45k','45000','NEW','LOW',0.6,'bún bò 45k',1)`).run();
});
test("05 submission created", () => {
  s1 = sub();
  assert.ok(s1);
});
test("06 second open submission for the same person is refused", () => throws(sub, /UNIQUE/));
test("07 pseudonymous customer message accepted", () => {
  m1 = custMsg();
  db.prepare(`INSERT INTO kb_ingest_message_media (message_id, position, media_type, external_file_id, mime_type) VALUES (?, 0, 'photo', 'F', 'image/jpeg')`).run(m1);
});
test("08 customer verbatim text in the append-only row refused", () =>
  throws(() => db.prepare(`INSERT INTO kb_ingest_messages (channel, chat_id, message_id, sender_role, raw_update_json, source_type, submission_id, sender_hash, sender_hash_kid, text) VALUES ('telegram', ?, 'tx', 'member', '{}', 'user_contribution', ?, ?, 'k1', 'call 0901234567')`).run(H, s1, H), /pseudonymous/));
test("09 raw update carrying the caption refused", () => throws(() => custMsg({ raw: '{"message":{"caption":"hi"}}' }), /pseudonymous/));
test("10 purge record append-only + unique", () => {
  db.prepare(`INSERT INTO kb_ingest_purges (target_kind, target_id, reason, purged_by) VALUES ('source', 99, 'contributor_request', 'founder')`).run();
  throws(() => db.prepare(`INSERT INTO kb_ingest_purges (target_kind, target_id, reason, purged_by) VALUES ('source', 99, 'retention', 'x')`).run(), /UNIQUE/);
  throws(() => db.prepare(`DELETE FROM kb_ingest_purges`).run(), /append-only/);
});
test("11 raw sender_id refused", () => throws(() => custMsg({ sender_id: "12345" }), /pseudonymous/));
test("12 display name refused", () => throws(() => custMsg({ sender_display_name: "Lan" }), /pseudonymous/));
test("13 raw chat id refused", () => throws(() => custMsg({ chat_id: "12345" }), /pseudonymous/));
test("14 raw update with from refused", () => throws(() => custMsg({ raw: '{"message":{"from":{"id":1}}}' }), /pseudonymous/));
test("15 raw update with chat refused", () => throws(() => custMsg({ raw: '{"message":{"chat":{"id":1}}}' }), /pseudonymous/));
test("16 customer message without submission refused", () => throws(() => custMsg({ submission_id: null }), /pseudonymous/));
test("17 group message with submission refused", () => throws(() => db.prepare(`INSERT INTO kb_ingest_messages (channel, chat_id, message_id, sender_role, raw_update_json, submission_id) VALUES ('telegram','-100','9','member','{}',?)`).run(s1), /no submission/));
test("18 customer message stays append-only", () => throws(() => db.prepare(`UPDATE kb_ingest_messages SET text='x' WHERE id=?`).run(m1), /append-only/));
test("19 customer candidate refused while the submission is not CANDIDATE (M2: SUBMITTED)", () => {
  db.prepare(`INSERT INTO kb_sources (url, source_type, fetched_at, content_type, content_hash, raw_path) VALUES ('ocr://abc/1','user_contribution','2026-09-27','text/plain','y','ingest/ocr/abc.txt')`).run();
  throws(() => cand(), /confirmed submission/);
});
test("20 illegal jump RECEIVED -> CANDIDATE (M2: SUBMITTED) refused", () => throws(() => move("CANDIDATE"), /transition/));
test("21 RECEIVED -> EXTRACTING -> WAITING_FOR_MERCHANT -> WAITING_FOR_CONFIRMATION -> CANDIDATE", () => {
  for (const s of ["EXTRACTING", "WAITING_FOR_MERCHANT", "WAITING_FOR_CONFIRMATION", "CANDIDATE"]) move(s);
});
test("22 WAITING_* (M2: AWAITING_*) needs expires_at", () => {
  const s = db.prepare(`INSERT INTO kb_ingest_submissions (channel, sender_hash, sender_hash_kid, status) VALUES ('zalo', ?, 'k1', 'EXTRACTING')`).run(H).lastInsertRowid;
  throws(() => db.prepare(`UPDATE kb_ingest_submissions SET status='WAITING_FOR_MERCHANT' WHERE id=?`).run(s), /CHECK/);
});
test("23 sender_hash of a submission immutable", () => throws(() => db.prepare(`UPDATE kb_ingest_submissions SET sender_hash='h1:b' WHERE id=?`).run(s1), /immutable/));
test("24 place cannot change after CANDIDATE (M2: SUBMITTED)", () => throws(() => db.prepare(`UPDATE kb_ingest_submissions SET place_resolution='{}' WHERE id=?`).run(s1), /immutable/));
test("25 customer candidate accepted once CANDIDATE", () => {
  c1 = cand();
  assert.ok(c1);
});
test("26 candidate without source (not INFERRED) refused", () => throws(() => cand({ source_id: null, raw: "46k" }), /evidence/));
test("27 empty quote refused", () => throws(() => cand({ quote: "  ", raw: "47k" }), /evidence/));
test("28 INFERRED food only as dish (no place / price from a photo)", () => throws(() => cand({ kind: "food", field: "price", assertion_kind: "INFERRED", source_id: null, raw: "x" }), /evidence/));
test("29 virtual resolved_kb_merchant_id", () => assert.equal(db.prepare(`SELECT resolved_kb_merchant_id r FROM kb_ingest_candidates WHERE id=?`).get(c1).r, 1186));
test("30 candidate evidence immutable", () => throws(() => db.prepare(`UPDATE kb_ingest_candidates SET normalized_value='1' WHERE id=?`).run(c1), /immutable/));
test("31 review -> applied directly refused", () => throws(() => db.prepare(`UPDATE kb_ingest_candidates SET status='applied' WHERE id=?`).run(c1), /decision/));
test("32 system cannot approve", () => throws(() => db.prepare(`UPDATE kb_ingest_candidates SET status='approved', decided_by='system' WHERE id=?`).run(c1), /decision/));
test("33 visible view: confirmed customer candidate visible, identity only as hash", () => {
  const r = db.prepare(`SELECT * FROM kb_contribution_visible WHERE candidate_id = ?`).get(c1);
  assert.equal(r.kb_merchant_id, 1186);
  assert.equal(r.media_type, "IMAGE");
  assert.equal(r.knowledge_kind, "USER_CONTRIBUTED_UNVERIFIED_EVIDENCE");
  assert.equal(r.sender_hash, H);
  assert.ok(!Object.keys(r).some((k) => /sender_id|display|chat|raw_update|quote|^text$/.test(k)), Object.keys(r).join(","));
});
test("34 blocked customer hash hides the candidate", () => {
  db.prepare(`INSERT INTO kb_ingest_contributors (channel, external_user_id, role, added_by) VALUES ('telegram', ?, 'blocked', 'founder')`).run(H);
  assert.equal(visible(c1), 0);
  db.prepare(`DELETE FROM kb_ingest_contributors WHERE external_user_id=?`).run(H);
  assert.equal(visible(c1), 1);
});
test("35 apply refused before approval", () => {
  db.prepare(`INSERT INTO kb_evidence (source_id, quote, extraction) VALUES (2, 'Bún bò Huế 45.000đ', 'explicit')`).run();
  throws(() => db.prepare(`INSERT INTO kb_ingest_applications (candidate_id, target_table, target_id, evidence_id, applied_by) VALUES (?, 'kb_product_prices', 1, 1, 'founder')`).run(c1), /approved/);
});
test("36 approve (a person) -> apply -> applied", () => {
  db.prepare(`UPDATE kb_ingest_candidates SET status='approved', decided_by='founder', decided_at=datetime('now') WHERE id=?`).run(c1);
  db.prepare(`INSERT INTO kb_ingest_applications (candidate_id, target_table, target_id, evidence_id, applied_by) VALUES (?, 'kb_product_prices', 1, 1, 'founder')`).run(c1);
  db.prepare(`UPDATE kb_ingest_candidates SET status='applied' WHERE id=?`).run(c1);
});
test("37 applied candidate leaves the visible set", () => assert.equal(visible(c1), 0));
test("38 CANDIDATE -> CLOSED; CLOSED is terminal", () => {
  move("CLOSED");
  throws(() => move("CANDIDATE"), /transition/);
});
test("39 a new submission may open after the previous closed", () => assert.ok(sub()));
test("40 events append-only, actor constrained", () => {
  db.prepare(`INSERT INTO kb_ingest_submission_events (submission_id, from_status, to_status, actor) VALUES (?, 'RECEIVED', 'EXTRACTING', 'system')`).run(s1);
  throws(() => db.prepare(`DELETE FROM kb_ingest_submission_events`).run(), /append-only/);
  throws(() => db.prepare(`INSERT INTO kb_ingest_submission_events (submission_id, to_status, actor) VALUES (?, 'X', 'anyone')`).run(s1), /CHECK/);
});
test("41 promotion (real promote.js) on a copy: no kb_ingest_* / view, no raw text, no contributor hash in the runtime file", async () => {
  db.pragma("wal_checkpoint(TRUNCATE)");
  const to = path.join(dir, "runtime.db");
  const manifest = await promoteKnowledge({ from: file, to, backupDir: path.join(dir, "backups") });
  assert.equal(manifest.rawIngestTables, 0);
  const Database = (await import("better-sqlite3")).default;
  const rt = new Database(to, { readonly: true });
  assert.equal(rt.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE 'kb_ingest%' OR name = 'kb_contribution_visible'`).get().n, 0);
  assert.equal(rt.prepare(`SELECT COUNT(*) AS n FROM kb_sources WHERE source_type = 'user_contribution' AND url NOT LIKE 'food://khach-hang-cung-cap/%'`).get().n, 0);
  rt.close();
  const bytes = fs.readFileSync(to);
  assert.ok(!bytes.includes(Buffer.from("Quán A bún bò 45k")), "raw group text not in the runtime bytes");
  assert.ok(!bytes.includes(Buffer.from(H)), "no contributor hash in the runtime bytes");
  assert.ok(fs.readFileSync(file).length > 0 && db.prepare(`SELECT COUNT(*) AS n FROM kb_ingest_messages`).get().n > 0, "the working DB keeps its evidence");
});
test("42 foreign_key_check clean", () => assert.deepEqual(db.pragma("foreign_key_check"), []));
test("43 integrity_check ok", () => assert.equal(db.pragma("integrity_check", { simple: true }), "ok"));
