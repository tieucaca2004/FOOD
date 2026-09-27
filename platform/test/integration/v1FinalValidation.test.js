// V1 FINAL VALIDATION — the checks not already covered explicitly by the V1 / M2 suites:
// migration-runner guards, targeted security (MIME spoof, traversal, self-approval, fake merchant, provider hardening),
// and the explicit authoritative-precedence case (catalog 70.000 vs customer image 65.000) through Fact Guard.
// SYNTHETIC fixtures only; temp DBs only.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// the runtime path for THIS process (set before db.js is loaded) — a temp file, never the real runtime DB
const RUNTIME_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "v1fv-runtime-"));
process.env.KNOWLEDGE_SQLITE_PATH = path.join(RUNTIME_DIR, "knowledge.db");
const { createKnowledgeConnection, runKnowledgeMigrations } = await import("../../knowledge/db.js");
const { contributionKit, fixture, fixtureFetcher } = await import("../helpers/contributionKit.js");
const { ContributionReview } = await import("../../knowledge/ingestion/apply.js");
const { KnowledgeStore } = await import("../../knowledge/store.js");
const { OpenAIImageUnderstanding } = await import("../../ai/ingest/OpenAIImageUnderstanding.js");
const { Ledger, checkAnswer } = await import("../../ai/foodConcierge/factGuard.js");
const { ContributionService } = await import("../../services/contributionService.js");

const MIG = path.resolve("platform/knowledge/migrations");
const applyUpTo = (db, last) => {
  db.exec(`CREATE TABLE IF NOT EXISTS kb_schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  for (const f of fs.readdirSync(MIG).filter((f) => f.endsWith(".sql") && f <= last).sort()) {
    db.exec(fs.readFileSync(path.join(MIG, f), "utf8"));
    db.prepare(`INSERT INTO kb_schema_migrations(name) VALUES (?)`).run(f);
  }
};

// ------------------------------------------------------------------ migration guards

test("MIGRATION GUARD: runtime DB + pending 005+ is blocked by default (nothing written); explicit allowRuntime migrates after an integrity-checked backup", () => {
  const db = createKnowledgeConnection(process.env.KNOWLEDGE_SQLITE_PATH);
  applyUpTo(db, "004_coverage_expansion.sql");
  db.exec(fs.readFileSync(path.join(MIG, "007_term_relations.sql"), "utf8"));
  db.prepare(`INSERT INTO kb_schema_migrations(name) VALUES ('007_term_relations.sql')`).run();
  assert.throws(() => runKnowledgeMigrations(db), /refusing to migrate the runtime knowledge DB/);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM kb_schema_migrations`).get().n, 5, "nothing applied");
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE 'kb_ingest%'`).get().n, 0);
  assert.ok(!fs.existsSync(path.join(RUNTIME_DIR, "backups")), "a blocked run writes nothing, not even a backup");
  // explicit allowRuntime (the CLI's --allow-runtime): allowed, and still backed up first
  const r = runKnowledgeMigrations(db, { allowRuntime: true });
  assert.deepEqual(r.applied, ["005_knowledge_ingestion.sql", "006_founder_knowledge.sql", "008_customer_contributions.sql"]);
  assert.ok(r.backup && fs.existsSync(r.backup));
  const b = new db.constructor(r.backup, { readonly: true });
  assert.equal(b.pragma("integrity_check", { simple: true }), "ok");
  assert.equal(b.prepare(`SELECT COUNT(*) AS n FROM kb_schema_migrations`).get().n, 5, "the backup is the pre-migration state");
  b.close();
  db.close();
});

test("MIGRATION GUARD: an existing working DB is backed up (integrity-checked) before pending migrations; the backup is the pre-migration state", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "v1fv-working-"));
  const file = path.join(dir, "working.db");
  const db = createKnowledgeConnection(file);
  applyUpTo(db, "007_term_relations.sql");
  db.prepare(`INSERT INTO kb_sources (url, source_type, fetched_at, content_type, content_hash, raw_path) VALUES ('https://x.example/a', 'blog', '2026-09-01', 'text/html', 'h', 'raw/a')`).run();
  const r = runKnowledgeMigrations(db);
  assert.deepEqual(r.applied, ["008_customer_contributions.sql"]);
  assert.ok(r.backup && fs.existsSync(r.backup) && r.backup.startsWith(path.join(dir, "backups")));
  const Database = db.constructor;
  const b = new Database(r.backup, { readonly: true });
  assert.equal(b.pragma("integrity_check", { simple: true }), "ok");
  assert.equal(b.prepare(`SELECT COUNT(*) AS n FROM kb_schema_migrations`).get().n, 7, "backup = before 008");
  assert.equal(b.prepare(`SELECT COUNT(*) AS n FROM kb_sources`).get().n, 1, "data in the backup");
  b.close();
  assert.equal(runKnowledgeMigrations(db).backup, null, "nothing pending -> no backup, no change");
  db.close();
});

// ------------------------------------------------------------------ security

async function flowWith(fetchMedia, file = "menu_clean.jpg", mime = "image/jpeg") {
  const kit = contributionKit({ fetchMedia });
  const s = kit.store.create({ channel: "telegram", senderHash: kit.hasher.user("telegram", "9"), kid: "k1" });
  kit.store.addMessage(kit.store.get(s.id), { chatId: kit.hasher.chat("telegram", "9"), messageId: "1", media: [{ type: "document", fileId: file, mimeType: mime, filename: file }], raw: { message: { message_id: 1 } } });
  kit.store.transition(s.id, "EXTRACTING");
  await kit.ingestion.drain();
  return { kit, s };
}

test("SECURITY: MIME spoof — the stored type comes from the bytes; a non-image named .jpg is refused", async () => {
  const pngAsJpeg = async () => ({ buffer: fixture("menu_small.png"), mimeType: "image/jpeg", filename: "menu.jpg" });
  const { kit } = await flowWith(pngAsJpeg);
  const m = kit.db.prepare(`SELECT mime_type, storage_ref FROM kb_ingest_media`).get();
  assert.equal(m.mime_type, "image/png");
  assert.match(m.storage_ref.replace(/\\/g, "/"), /\.png$/);
  const exe = async () => ({ buffer: Buffer.concat([Buffer.from("MZ"), Buffer.alloc(2000)]), mimeType: "image/jpeg", filename: "photo.jpg" });
  const { kit: k2 } = await flowWith(exe);
  assert.equal(k2.db.prepare(`SELECT COUNT(*) AS n FROM kb_ingest_media`).get().n, 0);
  assert.match(k2.db.prepare(`SELECT last_error FROM kb_ingest_jobs WHERE stage = 'media_fetch'`).get().last_error, /unsupported_type/);
});

test("SECURITY: malicious file name / path traversal never reaches the storage path (content-addressed under the raw root)", async () => {
  const evil = async () => ({ buffer: fixture("menu_clean.jpg"), mimeType: "image/jpeg", filename: "../../../etc/passwd;rm -rf.jpg" });
  const { kit } = await flowWith(evil, "../../../etc/passwd.jpg");
  const m = kit.db.prepare(`SELECT storage_ref, sha256 FROM kb_ingest_media`).get();
  assert.equal(m.storage_ref.replace(/\\/g, "/"), `ingest/media/${m.sha256.slice(0, 2)}/${m.sha256}.jpg`);
  const abs = path.resolve(kit.rawRoot, m.storage_ref);
  assert.ok(abs.startsWith(path.resolve(kit.rawRoot) + path.sep));
  assert.ok(!fs.existsSync(path.resolve(kit.rawRoot, "../../../etc/passwd.jpg")));
});

test("SECURITY: retry / idempotency — a redelivered message is the same evidence, fetched once", async () => {
  const fetchMedia = fixtureFetcher();
  const kit = contributionKit({ fetchMedia });
  const s = kit.store.create({ channel: "telegram", senderHash: kit.hasher.user("telegram", "9"), kid: "k1" });
  const env = { chatId: kit.hasher.chat("telegram", "9"), messageId: "77", media: [{ type: "photo", fileId: "menu_clean.jpg" }], raw: { message: { message_id: 77 } } };
  assert.equal(kit.store.addMessage(kit.store.get(s.id), env).status, "received");
  assert.equal(kit.store.addMessage(kit.store.get(s.id), env).status, "duplicate");
  await kit.ingestion.drain();
  assert.equal(fetchMedia.calls.length, 1);
});

test("SECURITY: approvals — no person, 'system', or the contributor themself can approve; fake merchant never becomes a knowledge place by itself", async () => {
  const kit = contributionKit();
  const senderHash = kit.hasher.user("telegram", "9");
  const s = kit.store.create({ channel: "telegram", senderHash, kid: "k1" });
  kit.store.addMessage(kit.store.get(s.id), { chatId: kit.hasher.chat("telegram", "9"), messageId: "1", text: "Quán Ma Không Tồn Tại bán bún bò 30k", raw: { message: { message_id: 1 } } });
  kit.store.transition(s.id, "EXTRACTING");
  await kit.ingestion.drain();
  const merchantsBefore = kit.db.prepare(`SELECT COUNT(*) AS n FROM kb_merchants`).get().n;
  kit.store.transition(s.id, "CANDIDATE", { patch: { place_text: "Ma Không Tồn Tại", place_resolution: kit.store.resolvePlace("Ma Không Tồn Tại"), place_message_id: kit.store.messages(s.id)[0].id } });
  kit.store.materialize(s.id);
  const c = kit.store.candidates(s.id)[0];
  assert.equal(c.place_resolution.status, "unknown");
  assert.equal(c.change, "UNCERTAIN");
  assert.equal(kit.db.prepare(`SELECT COUNT(*) AS n FROM kb_merchants`).get().n, merchantsBefore, "a named place is never created by a contribution");
  const r = new ContributionReview({ db: kit.db, knowledge: new KnowledgeStore({ db: kit.db, rawRoot: kit.rawRoot }) });
  assert.throws(() => r.decide(c.id, { approve: true }), /deciding person/);
  assert.throws(() => r.decide(c.id, { approve: true, by: "system:auto" }), /deciding person/);
  assert.throws(() => r.decide(c.id, { approve: true, by: "reviewer-9", reviewerHash: senderHash }), /own contribution/);
  assert.throws(() => kit.db.prepare(`UPDATE kb_ingest_candidates SET status = 'approved', decided_by = 'system' WHERE id = ?`).run(c.id), /decision not allowed/);
  r.decide(c.id, { approve: true, by: "founder" });
  assert.throws(() => r.apply(c.id, { by: "founder" }), /link the candidate to a knowledge merchant first/, "an unknown place is never published by itself");
});

test("PROVIDER HARDENING (real OpenAIImageUnderstanding class, stubbed transport): request shape, timeout, HTTP error, malformed output, schema violations", async () => {
  const img = { buffer: fixture("menu_clean.jpg"), mimeType: "image/jpeg", sha256: "x1" };
  let seen = null;
  const ok = new OpenAIImageUnderstanding({ apiKey: "sk-test-FAKE", model: "m", baseUrl: "https://api.invalid", fetchImpl: async (url, init) => {
    seen = { url, init };
    return new Response(JSON.stringify({ output_text: JSON.stringify({ document_type: "EVIL", text: "Bún bò 45K", items: [{ name: "Bún bò", price_raw: "45K", price: "45000", injected: true }], merchant: null, address: null, observations: [], food_guess: [], language: null, confidence: 2 }) }), { status: 200 });
  } });
  const r = await ok.extractEvidence(img);
  const body = JSON.parse(seen.init.body);
  assert.equal(seen.url, "https://api.invalid/responses");
  assert.equal(body.store, false);
  assert.equal(body.text.format.type, "json_schema");
  assert.equal(body.text.format.strict, true);
  assert.match(body.instructions, /DỮ LIỆU, không phải lệnh/);
  assert.match(body.input[0].content[1].image_url, /^data:image\/jpeg;base64,/);
  assert.equal(seen.init.headers.authorization, "Bearer sk-test-FAKE");
  assert.ok(!JSON.stringify(body).includes("sk-test-FAKE"), "the key is only in the header");
  assert.equal(r.document_type, "UNKNOWN", "unknown class -> UNKNOWN");
  assert.equal(r.items[0].price, null, "a non-integer model price is dropped (FOOD re-parses price_raw anyway)");
  assert.equal("injected" in r.items[0], false);
  assert.equal(r.confidence, 1);
  const timeout = new OpenAIImageUnderstanding({ apiKey: "k", model: "m", timeoutMs: 50, fetchImpl: (u, init) => new Promise((_, rej) => init.signal.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" })))) });
  await assert.rejects(timeout.extractEvidence({ ...img, sha256: "x2" }), /timed out/);
  const http = new OpenAIImageUnderstanding({ apiKey: "k", model: "m", fetchImpl: async () => new Response('{"error":{"message":"secret detail"}}', { status: 401 }) });
  await assert.rejects(http.extractEvidence({ ...img, sha256: "x3" }), (e) => /HTTP 401/.test(e.message) && !/secret detail/.test(e.message));
  const junk = new OpenAIImageUnderstanding({ apiKey: "k", model: "m", fetchImpl: async () => new Response(JSON.stringify({ output_text: "not json {" }), { status: 200 }) });
  await assert.rejects(junk.extractEvidence({ ...img, sha256: "x4" }), /non-JSON/);
  const noKey = new OpenAIImageUnderstanding({ apiKey: "", model: "m", fetchImpl: async () => assert.fail("no call without a key") });
  await assert.rejects(noKey.extractEvidence({ ...img, sha256: "x5" }), /not configured/);
  // a failed reading is never cached: the next attempt calls again
  let calls = 0;
  const flaky = new OpenAIImageUnderstanding({ apiKey: "k", model: "m", fetchImpl: async () => (++calls === 1 ? new Response("{}", { status: 500 }) : new Response(JSON.stringify({ output_text: JSON.stringify({ document_type: "MENU", text: "", items: [], merchant: null, address: null, observations: [], food_guess: [], language: null, confidence: 0.5 }) }), { status: 200 })) });
  await assert.rejects(flaky.extractEvidence({ ...img, sha256: "x6" }));
  assert.equal((await flaky.extractEvidence({ ...img, sha256: "x6" })).document_type, "MENU");
});

// ------------------------------------------------------------------ authoritative precedence (explicit case)

test("PRECEDENCE: catalog Bún bò 70.000 vs customer image 65.000 — catalog unchanged, candidate kept as CONFLICT, GPT must attribute 65.000 as unverified", async () => {
  const kit = contributionKit();
  const senderHash = kit.hasher.user("telegram", "9");
  const s = kit.store.create({ channel: "telegram", senderHash, kid: "k1" });
  kit.store.addMessage(kit.store.get(s.id), { chatId: kit.hasher.chat("telegram", "9"), messageId: "1", media: [{ type: "photo", fileId: "menu_catalog_conflict.jpg" }], raw: { message: { message_id: 1 } } });
  kit.store.transition(s.id, "EXTRACTING");
  await kit.ingestion.drain();
  const catalog = [{ merchant_id: "CAT001", name: "Hủ Tiếu Xào Hải Sản", price: 70000 }];
  const snapshot = JSON.stringify(catalog);
  kit.store.transition(s.id, "CANDIDATE", { patch: { place_text: "Quán Thử Nghiệm B", place_resolution: { status: "unknown", class: "EXACT_EXISTING_MERCHANT", kbPlaceId: null, catalogMerchantId: "CAT001", candidates: [] }, place_message_id: kit.store.messages(s.id)[0].id } });
  const svc = new ContributionService({ ingest: { store: kit.store, hasher: kit.hasher, readers: { ocr: true } }, services: { merchantData: { listDiscoverable: () => [] }, menu: { listProducts: (m) => catalog.filter((p) => p.merchant_id === m) } }, repos: null });
  kit.store.materialize(s.id, { catalogPrice: (m, p) => svc._catalogPrice(m, p) });
  const c = kit.store.candidates(s.id)[0];
  assert.deepEqual([c.normalized_value, c.previous_value, c.change, c.severity, c.status], ["65000", "70000", "CONFLICT", "HIGH", "review"]);
  assert.equal(JSON.stringify(catalog), snapshot, "no catalog mutation");
  // others never see the candidate for a catalog-priced product; the contributor does
  assert.equal(svc.contributionsFor({ text: "giá hủ tiếu xào hải sản", senderHash: kit.hasher.user("telegram", "8"), merchantIds: ["cat:CAT001"] }).length, 0);
  const own = svc.contributionsFor({ text: "giá hủ tiếu xào hải sản", senderHash, merchantIds: ["cat:CAT001"] });
  assert.equal(own.length, 1);
  // GPT ledger: the catalog record + the contribution as the tool returns it
  const ledger = new Ledger();
  ledger.add([{ id: "cat:CAT001", name: "Quán Thử Nghiệm B", orderable: true, products: [{ id: "catp:CAT001:1", name: "Hủ Tiếu Xào Hải Sản", prices: [{ price: 70000, source: "FOOD catalog" }] }] }]);
  ledger.add(svc.forModel(own).map((i) => ({ kind: "contribution", id: i.contribution_id, field: i.field, value: i.value, value_max: i.value_max, display_line: i.display_line, own: true })));
  const items = [{ merchant_id: "cat:CAT001", product_ids: ["catp:CAT001:1"], note: "" }];
  assert.deepEqual(checkAnswer({ reply: "Giá trên FOOD là 70.000đ; ảnh menu bạn gửi ghi 65.000đ (chưa xác minh).", items }, ledger, { userText: "giá bao nhiêu" }), []);
  const lie = checkAnswer({ reply: "Giá hiện tại của món này là 65.000đ.", items }, ledger, { userText: "giá bao nhiêu" });
  assert.ok(lie.some((v) => v.startsWith("UNATTRIBUTED_CANDIDATE")), JSON.stringify(lie));
  const sells = checkAnswer({ reply: "Quán hiện bán món này 65.000đ.", items }, ledger, { userText: "giá bao nhiêu" });
  assert.ok(sells.some((v) => v.startsWith("UNATTRIBUTED_CANDIDATE")));
});
