// FK-1 Founder / Business Knowledge: storage, review, versions, provenance — TEXT only, never read by GPT yet.
// Temp knowledge DBs only (the SYNTHETIC Nha Trang fixture); never the collector or runtime DB.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { nhaTrangKnowledge } from "../helpers/nhaTrangKnowledge.js";
import { buildTestPlatform } from "../helpers/testPlatform.js";
import { createKnowledgeConnection, runKnowledgeMigrations } from "../../knowledge/db.js";
import { FounderKnowledgeService, factLikeWarnings } from "../../knowledge/founder/founderKnowledgeService.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../../..");

function setup() {
  const file = nhaTrangKnowledge();
  const db = createKnowledgeConnection(file);
  runKnowledgeMigrations(db);
  const rawRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fk-raw-"));
  return { db, file, rawRoot, fk: new FounderKnowledgeService({ db, rawRoot }) };
}
const policy = (fk, extra = {}) => fk.createFromText({ type: "POLICY", title: "Xưng hô", text: "Luôn xưng em và gọi khách là anh/chị.", author: "founder", ...extra });
const approveFlow = (fk, id, by = "founder") => (fk.submitForReview(id, by), fk.approve(id, { by }));

test("LIFECYCLE: draft -> review -> approved (active) -> retired (inactive); drafts and reviews are never active", () => {
  const { fk } = setup();
  const d = policy(fk);
  assert.deepEqual([d.status, d.version, d.lineageId, d.audience, d.scope], ["DRAFT", 1, d.id, "customer", "global"]);
  assert.deepEqual(fk.getActiveApproved(), []);
  const r = fk.submitForReview(d.id, "founder");
  assert.equal(r.status, "REVIEW");
  assert.deepEqual(fk.getActiveApproved(), []);
  const back = fk.returnToDraft(d.id, "founder", "sửa lại câu chữ");
  assert.equal(back.status, "DRAFT");
  fk.editDraft(d.id, { body: "Luôn xưng em và gọi khách là anh/chị, mở đầu bằng Dạ." }, "founder");
  fk.submitForReview(d.id, "founder");
  const a = fk.approve(d.id, { by: "founder" });
  assert.deepEqual([a.status, a.approvedBy], ["APPROVED", "founder"]);
  assert.ok(a.approvedAt);
  assert.deepEqual(fk.getActiveApproved().map((i) => i.id), [d.id]);
  const gone = fk.retire(d.id, { by: "founder", reason: "không dùng nữa" });
  assert.equal(gone.status, "RETIRED");
  assert.deepEqual(fk.getActiveApproved(), []);
  assert.deepEqual(gone.events.map((e) => e.action), ["created", "evidence_linked", "submitted", "returned", "edited", "submitted", "approved", "retired"]);
  assert.throws(() => fk.submitForReview(d.id, "founder"), /INVALID_TRANSITION|RETIRED/);
  assert.throws(() => fk.approve(d.id, { by: "founder" }), /not allowed/);
});

test("APPROVAL: a person only; nothing is approved by AI or without review", () => {
  const { fk } = setup();
  const d = policy(fk);
  assert.throws(() => fk.approve(d.id, { by: "founder" }), /submit it for review first/);
  fk.submitForReview(d.id, "founder");
  for (const by of ["ai:gpt-5.6-terra", "model", "GPT", "system:auto", "", null]) assert.throws(() => fk.approve(d.id, { by }), /person/, String(by));
  assert.equal(fk.approve(d.id, { by: "Phong" }).status, "APPROVED");
});

test("VERSIONS: an approved version is immutable; a change is a new version that supersedes it", () => {
  const { db, fk } = setup();
  const v1 = approveFlow(fk, policy(fk).id);
  assert.throws(() => fk.editDraft(v1.id, { body: "khác" }, "founder"), /only a DRAFT can be edited/);
  // the database refuses too, whatever the caller
  assert.throws(() => db.prepare(`UPDATE kb_founder_items SET body = 'đổi lén' WHERE id = ?`).run(v1.id), /immutable/);
  assert.throws(() => db.prepare(`UPDATE kb_founder_items SET priority = 99 WHERE id = ?`).run(v1.id), /immutable/);
  assert.throws(() => db.prepare(`DELETE FROM kb_founder_items WHERE id = ?`).run(v1.id), /never deleted/);
  const v2 = fk.revise(v1.id, { body: "Luôn xưng em, gọi khách anh/chị, mở đầu bằng Dạ." }, "founder");
  assert.deepEqual([v2.status, v2.version, v2.lineageId, v2.supersedesId], ["DRAFT", 2, v1.lineageId, v1.id]);
  assert.deepEqual(fk.getActiveApproved().map((i) => i.id), [v1.id]); // v1 stays in force until v2 is approved
  assert.equal(v2.evidence.length, 1); // provenance carries over
  approveFlow(fk, v2.id);
  assert.equal(fk.get(v1.id).status, "RETIRED");
  assert.match(fk.get(v1.id).retiredReason, /superseded by #\d+ \(v2\)/);
  assert.deepEqual(fk.getActiveApproved().map((i) => [i.id, i.version]), [[v2.id, 2]]);
  assert.equal(fk.get(v1.id).body, "Luôn xưng em và gọi khách là anh/chị."); // the old text is still there, unchanged
  assert.throws(() => db.prepare(`UPDATE kb_founder_items SET status = 'APPROVED' WHERE id = ?`).run(v1.id), /immutable/); // retired stays retired
  // one approved version per lineage, whatever the caller
  assert.throws(() => db.prepare(`UPDATE kb_founder_items SET status = 'APPROVED', approved_by = 'x', approved_at = 'y' WHERE id = ?`).run(fk.revise(v2.id, {}, "founder").id), /UNIQUE|immutable|constraint/);
});

test("SCOPE / AUDIENCE / INTERNAL_NOTE: customer reads never see internal notes; scope filtering keeps global items", () => {
  const { fk } = setup();
  const g = approveFlow(fk, policy(fk).id);
  const region = approveFlow(fk, fk.createFromText({ type: "ADVICE_STYLE", title: "Nha Trang", text: "Ở Nha Trang, gợi ý khách hỏi món hải sản theo mùa.", scope: "region", scopeRef: "vn.khanh-hoa.nha-trang", author: "founder" }).id);
  const place = approveFlow(fk, fk.createFromText({ type: "FOOD_RECOMMENDATION", title: "Gợi ý", text: "Nếu khách thích bún cá, có thể giới thiệu thêm món chả cá.", scope: "merchant", scopeRef: "kb:1", author: "founder" }).id);
  const note = approveFlow(fk, fk.createFromText({ type: "INTERNAL_NOTE", title: "Nội bộ", text: "Quán này hay giao trễ, theo dõi thêm.", author: "founder" }).id);
  assert.equal(note.audience, "internal");
  assert.throws(() => fk.createFromText({ type: "INTERNAL_NOTE", title: "x", text: "y", audience: "customer", author: "founder" }), /never customer-facing/);
  assert.throws(() => fk.createFromText({ type: "POLICY", title: "x", text: "y", scope: "region", scopeRef: "vn.khong-ton-tai", author: "founder" }), /unknown region/);
  assert.throws(() => fk.createFromText({ type: "POLICY", title: "x", text: "y", scope: "merchant", scopeRef: "Quán A", author: "founder" }), /cat:<id>/);
  assert.throws(() => fk.createFromText({ type: "POLICY", title: "x", text: "y", scope: "global", scopeRef: "kb:1", author: "founder" }), /global has no scope ref/);
  const customer = fk.getActiveApproved().map((i) => i.id);
  assert.deepEqual(customer.sort(), [g.id, region.id, place.id].sort());
  assert.ok(!customer.includes(note.id));
  assert.ok(fk.getActiveApproved({ audience: "internal" }).some((i) => i.id === note.id)); // only when asked for explicitly
  assert.deepEqual(fk.getActiveApproved({ scope: "region", scopeRef: "vn.khanh-hoa.nha-trang" }).map((i) => i.id).sort(), [g.id, region.id].sort());
  assert.deepEqual(fk.getActiveApproved({ scope: "merchant", scopeRef: "kb:2" }).map((i) => i.id), [g.id]);
  assert.deepEqual(fk.getActiveApproved({ type: "FOOD_RECOMMENDATION" }).map((i) => i.id), [place.id]);
});

test("VALIDITY WINDOW: an approved item is active only between valid_from and valid_to", () => {
  const { fk } = setup();
  const seasonal = approveFlow(fk, fk.createFromText({ type: "FAQ", title: "Tết", text: "Dịp Tết nhiều quán nghỉ, nhắc khách hỏi lại trước khi đến.", validFrom: "2027-01-20T00:00:00Z", validTo: "2027-02-10T00:00:00Z", author: "founder" }).id);
  assert.deepEqual(fk.getActiveApproved({ at: new Date("2026-12-31T00:00:00Z") }), []);
  assert.deepEqual(fk.getActiveApproved({ at: new Date("2027-01-25T00:00:00Z") }).map((i) => i.id), [seasonal.id]);
  assert.deepEqual(fk.getActiveApproved({ at: new Date("2027-02-10T00:00:00Z") }), []);
  assert.throws(() => fk.createFromText({ type: "FAQ", title: "x", text: "y", validFrom: "2027-02-01", validTo: "2027-01-01", author: "founder" }), /valid_to/);
});

test("PROVENANCE: every item traces to a verbatim quote of a stored, hashed source; sources are append-only", () => {
  const { db, fk, rawRoot } = setup();
  const d = policy(fk);
  const [e] = d.evidence;
  assert.equal(e.kind, "text");
  assert.equal(fs.readFileSync(path.join(rawRoot, e.raw_path), "utf8"), "Luôn xưng em và gọi khách là anh/chị.");
  assert.equal(e.sha256.length, 64);
  assert.equal(policy(fk).evidence[0].source_id, e.source_id); // the same text is the same source
  const source = fk.addTextSource({ text: "Ghi chú dài của founder: không bao giờ hứa thời gian giao hàng cụ thể.", submittedBy: "founder" });
  const bare = fk.createDraft({ type: "POLICY", title: "Giao hàng", body: "Không hứa thời gian giao hàng cụ thể.", author: "founder" });
  assert.throws(() => fk.submitForReview(bare.id, "founder"), /needs evidence/);
  assert.throws(() => fk.linkEvidence(bare.id, { sourceId: source.id, quote: "hứa giao trong 10 phút" }, "founder"), /not in its source/);
  fk.linkEvidence(bare.id, { sourceId: source.id, quote: "không bao giờ hứa thời gian giao hàng cụ thể" }, "founder");
  assert.equal(fk.submitForReview(bare.id, "founder").status, "REVIEW");
  // a tampered raw file is detected, and sources / evidence / events cannot be rewritten
  fs.writeFileSync(path.join(rawRoot, source.raw_path), "đã bị sửa");
  assert.throws(() => fk.linkEvidence(bare.id, { sourceId: source.id, quote: "đã bị sửa" }, "founder"), /no longer matches/);
  for (const t of ["kb_founder_sources", "kb_founder_evidence", "kb_founder_events"]) {
    assert.throws(() => db.prepare(`DELETE FROM ${t}`).run(), /append-only/, t);
  }
  // an ingestion message can be a source too (images / documents later)
  db.prepare(`INSERT INTO kb_ingest_messages (channel, chat_id, message_id, sender_role, text, raw_update_json) VALUES ('telegram', '-1', '9', 'admin', 'Quy tắc: khách hỏi thuốc thì từ chối nhẹ nhàng.', '{}')`).run();
  const msgSource = fk.addIngestMessageSource({ ingestMessageId: db.prepare(`SELECT id FROM kb_ingest_messages`).get().id, submittedBy: "founder" });
  const fromMsg = fk.createDraft({ type: "POLICY", title: "Thuốc", body: "Khách hỏi thuốc thì từ chối nhẹ nhàng.", author: "founder", evidence: [{ sourceId: msgSource.id, quote: "khách hỏi thuốc thì từ chối nhẹ nhàng" }] });
  assert.equal(fromMsg.evidence[0].kind, "ingest_message");
});

test("NOT A FACT: text that looks like a price / hours / address / availability is flagged and needs an explicit acknowledgement", () => {
  const { fk } = setup();
  assert.deepEqual(factLikeWarnings("Bún cá chỉ 45k thôi"), ["PRICE"]);
  assert.deepEqual(factLikeWarnings("Luôn xưng em, gọi khách anh/chị."), []);
  const d = fk.createFromText({ type: "POLICY", title: "Giá", text: "Đừng hứa giá dưới 30.000đ nếu menu chưa ghi.", author: "founder" });
  assert.deepEqual(d.warnings, ["PRICE"]);
  fk.submitForReview(d.id, "founder");
  assert.throws(() => fk.approve(d.id, { by: "founder" }), /looks like an authoritative fact \(PRICE\)/);
  const ok = fk.approve(d.id, { by: "founder", ackWarnings: true });
  assert.equal(ok.status, "APPROVED");
  assert.match(ok.events.at(-1).note, /acknowledged: PRICE/);
});

test("ISOLATION: founder knowledge never changes Food Knowledge facts or the FOOD catalog, and only the adapter reads it", () => {
  const { db, fk } = setup();
  const facts = ["kb_food_entities", "kb_food_names", "kb_merchants", "kb_merchant_products", "kb_product_prices", "kb_merchant_locations", "kb_merchant_claims", "kb_sources", "kb_evidence", "kb_food_product_links"];
  const factCounts = () => facts.map((t) => db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n);
  const platform = buildTestPlatform({ withAtieu: true, atieuEngine: "generic", withNomNomDemo: true });
  const catalog = () => ["merchants", "merchant_products", "merchant_carts", "orders"].map((t) => platform.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n);
  const before = { facts: factCounts(), catalog: catalog() };
  const d = fk.createFromText({ type: "FOOD_RECOMMENDATION", title: "Gợi ý", text: "Khách thích cay thì gợi ý bún cá thêm ớt.", scope: "merchant", scopeRef: "cat:DEMO_NOMNOM001", author: "founder" });
  approveFlow(fk, d.id);
  fk.revise(d.id, { body: "Khách thích cay thì hỏi thêm mức cay." }, "founder");
  assert.deepEqual({ facts: factCounts(), catalog: catalog() }, before);
  // wired read-only ONLY through the Food Knowledge adapter (GPT-FOUNDER); otherwise just the CLI imports the founder module
  const files = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (["node_modules", "test", "knowledge"].includes(e.name) ? [] : files(path.join(dir, e.name))) : e.name.endsWith(".js") ? [path.join(dir, e.name)] : []));
  const importers = files(path.join(REPO, "platform")).filter((f) => /knowledge\/founder\//.test(fs.readFileSync(f, "utf8")));
  assert.deepEqual(importers.map((f) => path.relative(REPO, f).replace(/\\/g, "/")).sort(), ["platform/scripts/knowledge.js", "platform/services/foodKnowledgeAdapter.js"]);
});

test("MIGRATION 006: applied once, tables / triggers / indexes present; re-running migrations is a no-op", () => {
  const { db } = setup();
  assert.ok(db.prepare(`SELECT 1 FROM kb_schema_migrations WHERE name = '006_founder_knowledge.sql'`).get());
  const objects = db.prepare(`SELECT type || ':' || name AS o FROM sqlite_master WHERE name LIKE '%founder%'`).all().map((r) => r.o);
  for (const o of ["table:kb_founder_items", "table:kb_founder_sources", "table:kb_founder_evidence", "table:kb_founder_events", "trigger:kb_founder_items_approved_immutable", "trigger:kb_founder_items_retired_immutable", "index:idx_kb_founder_items_one_approved"]) assert.ok(objects.includes(o), o);
  const count = db.prepare(`SELECT COUNT(*) AS n FROM kb_schema_migrations`).get().n;
  runKnowledgeMigrations(db);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM kb_schema_migrations`).get().n, count);
  assert.equal(db.pragma("integrity_check", { simple: true }), "ok");
});

test("CLI: founder-add / list / review / approve / retire on a temp DB show status, version, source and evidence", () => {
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fk-cli-")), "knowledge.db");
  const rawRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fk-cli-raw-"));
  const run = (...args) => execFileSync(process.execPath, [path.join(REPO, "platform/scripts/knowledge.js"), ...args], { cwd: REPO, env: { ...process.env, FOUNDER_KNOWLEDGE_DB_PATH: dbPath, KNOWLEDGE_INGEST_RAW_ROOT: rawRoot }, encoding: "utf8" });
  const added = run("founder-add", "--type", "POLICY", "--title", "Xưng hô", "--text", "Luôn xưng em và gọi khách là anh/chị.", "--author", "founder");
  assert.match(added, /#1 \[DRAFT\] POLICY v1 \(lineage #1\) — Xưng hô/);
  assert.match(added, /evidence #1: "Luôn xưng em và gọi khách là anh\/chị\." — source #1 text founder[\\/][0-9a-f]{64}\.txt sha [0-9a-f]{12} by founder/);
  assert.match(run("founder-review", "1", "--by", "founder"), /\[REVIEW\]/);
  const approved = run("founder-approve", "1", "--by", "founder");
  assert.match(approved, /\[APPROVED\][\s\S]*approved by founder/);
  assert.match(run("founder-list", "--active"), /#1 \[APPROVED\] POLICY v1/);
  const revised = run("founder-add", "--revise", "1", "--text", "Luôn xưng em, gọi khách anh/chị, mở đầu bằng Dạ.", "--author", "founder");
  assert.match(revised, /#2 \[DRAFT\] POLICY v2 \(lineage #1, supersedes #1\)/);
  assert.match(run("founder-list"), /#1 \[APPROVED\][\s\S]*#2 \[DRAFT\]/);
  assert.match(run("founder-retire", "1", "--by", "founder", "--reason", "thay bằng v2"), /\[RETIRED\][\s\S]*retired by founder/);
  assert.throws(() => run("founder-approve", "2", "--by", "ai:gpt"), /Command failed/); // not a person, and not reviewed
});
