// Multimodal V1 — PHASE 1–3 gate: submission data model, pending state on the submission, server-side image
// storage (hash, dedupe, metadata), privacy of stored rows. SYNTHETIC fixtures, temp DB, fake reader.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { contributionKit, fixture, dumpAll, TEST_HASH_KEY } from "../helpers/contributionKit.js";
import { ContributorHasher, contributorHasherFromEnv } from "../../knowledge/ingestion/contributorHash.js";
import { checkImage } from "../../knowledge/ingestion/imageCheck.js";

const RAW_USER = "987654321";
const RAW_NAME = "Nguyễn Văn Thử";

function start(kit, { channel = "telegram", user = RAW_USER, sessionRef = 42 } = {}) {
  const senderHash = kit.hasher.user(channel, user);
  const submission = kit.store.create({ channel, senderHash, kid: kit.hasher.kid, sessionRef });
  const chatId = kit.hasher.chat(channel, user);
  let seq = 0;
  const send = ({ file = null, caption = null, text = null, messageId = null } = {}) =>
    kit.store.addMessage(kit.store.get(submission.id), {
      chatId,
      messageId: messageId ?? String(1000 + ++seq),
      updateId: String(5000 + seq),
      sentAt: "2026-09-27T08:59:00Z",
      text,
      caption,
      media: file ? [{ type: "photo", fileId: file, mimeType: "image/jpeg" }] : [],
      raw: { update_id: 5000 + seq, message: { message_id: 1000 + seq, date: 1790499540, ...(file && { photo: [{ file_id: file }] }) } },
    });
  return { submission, senderHash, chatId, send };
}

test("HASH: keyed, stable, per channel and scope; no key -> contribution off (fail-closed)", () => {
  const h = new ContributorHasher({ key: TEST_HASH_KEY });
  assert.equal(h.user("telegram", RAW_USER), h.user("telegram", RAW_USER));
  assert.match(h.user("telegram", RAW_USER), /^h1:[0-9a-f]{64}$/);
  assert.notEqual(h.user("telegram", RAW_USER), h.user("zalo", RAW_USER));
  assert.notEqual(h.user("telegram", RAW_USER), h.chat("telegram", RAW_USER));
  assert.notEqual(h.user("telegram", RAW_USER), new ContributorHasher({ key: `${TEST_HASH_KEY}x` }).user("telegram", RAW_USER));
  assert.ok(!h.user("telegram", RAW_USER).includes(RAW_USER));
  assert.equal(JSON.stringify(h).includes(TEST_HASH_KEY), false, "the key is never serialised");
  assert.throws(() => new ContributorHasher({ key: "short" }), /at least 32 bytes/);
  assert.equal(contributorHasherFromEnv({ key: "" }), null);
  assert.equal(contributorHasherFromEnv({ key: "too-short" }), null);
});

test("SUBMISSION: one open per person; the pending state lives on the submission; transitions are deterministic", () => {
  const kit = contributionKit();
  const { submission } = start(kit);
  assert.equal(submission.status, "RECEIVED");
  assert.equal(submission.session_ref, "42");
  assert.throws(() => kit.store.create({ channel: "telegram", senderHash: submission.sender_hash, kid: "k1" }), /UNIQUE/);
  assert.equal(kit.store.open("telegram", submission.sender_hash).id, submission.id);
  assert.throws(() => kit.store.transition(submission.id, "CANDIDATE"), /transition not allowed/);
  kit.store.transition(submission.id, "EXTRACTING");
  const waiting = kit.store.transition(submission.id, "WAITING_FOR_MERCHANT", { reason: "place_unknown" });
  assert.equal(waiting.expires_at, "2026-09-27T09:30:00.000Z");
  assert.deepEqual(kit.store.events(submission.id).map((e) => e.to_status), ["RECEIVED", "EXTRACTING", "WAITING_FOR_MERCHANT"]);
  assert.throws(() => kit.db.prepare(`DELETE FROM kb_ingest_submission_events`).run(), /append-only/);
  assert.throws(() => kit.db.prepare(`UPDATE kb_ingest_submissions SET sender_hash = 'h1:x' WHERE id = ?`).run(submission.id), /immutable/);
});

test("SUBMISSION: a waiting submission expires lazily after its TTL; its evidence stays", () => {
  let now = new Date("2026-09-27T09:00:00Z");
  const kit = contributionKit({ now: () => now });
  const { submission, send } = start(kit);
  send({ file: "menu_clean.jpg" });
  kit.store.transition(submission.id, "EXTRACTING");
  kit.store.transition(submission.id, "WAITING_FOR_CONFIRMATION");
  now = new Date("2026-09-27T09:31:00Z");
  assert.equal(kit.store.open("telegram", submission.sender_hash), null);
  assert.equal(kit.store.get(submission.id).status, "EXPIRED");
  assert.equal(kit.store.messages(submission.id).length, 1, "evidence kept");
  // a new submission may open now
  assert.ok(kit.store.create({ channel: "telegram", senderHash: submission.sender_hash, kid: "k1" }).id);
});

test("STORAGE: the server downloads the original image, validates it, stores it content-addressed with metadata; the same image twice = one file", async () => {
  const kit = contributionKit();
  const { submission, send } = start(kit);
  const r1 = send({ file: "menu_clean.jpg", caption: "Đây là menu quán Bún Mẫu Thử" });
  await kit.ingestion.processPending();
  const media = kit.db.prepare(`SELECT * FROM kb_ingest_media`).all();
  assert.equal(media.length, 1);
  const expectedSha = crypto.createHash("sha256").update(fixture("menu_clean.jpg")).digest("hex");
  assert.equal(media[0].sha256, expectedSha);
  assert.equal(media[0].mime_type, "image/jpeg");
  assert.equal(media[0].size_bytes, fixture("menu_clean.jpg").length);
  assert.equal(media[0].storage_ref.replace(/\\/g, "/"), `ingest/media/${expectedSha.slice(0, 2)}/${expectedSha}.jpg`);
  const stored = fs.readFileSync(path.join(kit.rawRoot, media[0].storage_ref));
  assert.ok(stored.equals(fixture("menu_clean.jpg")), "the original bytes, unchanged");
  // metadata: message id, received / sent time, platform, per-message media link
  const msg = kit.db.prepare(`SELECT * FROM kb_ingest_messages WHERE id = ?`).get(r1.id);
  assert.equal(msg.channel, "telegram");
  assert.equal(msg.source_type, "user_contribution");
  assert.equal(msg.submission_id, submission.id);
  assert.equal(msg.sent_at, "2026-09-27T08:59:00Z");
  assert.ok(msg.received_at);
  assert.equal(kit.db.prepare(`SELECT COUNT(*) AS n FROM kb_ingest_fetched WHERE media_id = ?`).get(media[0].id).n, 1);
  // the same picture again (another message) -> the same hash, no second binary, marked duplicate
  send({ file: "menu_clean.jpg" });
  await kit.ingestion.processPending();
  assert.equal(kit.db.prepare(`SELECT COUNT(*) AS n FROM kb_ingest_media`).get().n, 1);
  assert.deepEqual(kit.db.prepare(`SELECT duplicate_of_earlier AS d FROM kb_ingest_fetched ORDER BY message_media_id`).all().map((x) => x.d), [0, 1]);
  const files = fs.readdirSync(path.join(kit.rawRoot, "ingest", "media", expectedSha.slice(0, 2)));
  assert.deepEqual(files, [`${expectedSha}.jpg`]);
  // the image is read ONCE (memoised by hash / reused extraction)
  assert.equal(kit.reader.calls, 1);
  // evidence rows are append-only
  assert.throws(() => kit.db.prepare(`DELETE FROM kb_ingest_media`).run(), /append-only/);
});

test("PRIVACY: no raw platform id, name or customer words in any row; the caption lives only in the purgeable source file", async () => {
  const kit = contributionKit();
  const { send, chatId } = start(kit);
  const r = send({ file: "menu_clean.jpg", caption: "Menu mới của quán Bún Mẫu Thử" });
  await kit.ingestion.processPending();
  const msg = kit.db.prepare(`SELECT * FROM kb_ingest_messages WHERE id = ?`).get(r.id);
  assert.equal(msg.sender_id, null);
  assert.equal(msg.sender_display_name, null);
  assert.equal(msg.text, null);
  assert.equal(msg.caption, null);
  assert.equal(msg.chat_id, chatId);
  const source = kit.db.prepare(`SELECT * FROM kb_sources WHERE id = ?`).get(msg.source_id);
  assert.equal(source.source_type, "user_contribution");
  assert.equal(fs.readFileSync(path.join(kit.rawRoot, source.raw_path), "utf8"), "Menu mới của quán Bún Mẫu Thử");
  const dump = dumpAll(kit.db, kit.rawRoot);
  assert.ok(!dump.includes(RAW_USER), "raw platform id appears nowhere (rows, paths, files)");
  assert.ok(!dump.includes(RAW_NAME));
  assert.ok(!dump.includes(TEST_HASH_KEY), "the key is never stored");
  // the DB itself refuses a raw id / name / words on a customer row
  const bad = (over) =>
    kit.db.prepare(`INSERT INTO kb_ingest_messages (channel, chat_id, message_id, sender_id, sender_display_name, sender_role, raw_update_json, source_type, submission_id, sender_hash, sender_hash_kid, text) VALUES ('telegram', ?, ?, ?, ?, 'member', ?, 'user_contribution', ?, ?, 'k1', ?)`).run(
      over.chat ?? chatId, String(Math.random()), over.sender ?? null, over.name ?? null, over.raw ?? "{}", msg.submission_id, msg.sender_hash, over.text ?? null
    );
  assert.throws(() => bad({ sender: RAW_USER }), /pseudonymous/);
  assert.throws(() => bad({ name: RAW_NAME }), /pseudonymous/);
  assert.throws(() => bad({ chat: RAW_USER }), /pseudonymous/);
  assert.throws(() => bad({ text: "hello" }), /pseudonymous/);
  assert.throws(() => bad({ raw: JSON.stringify({ message: { from: { id: 1 } } }) }), /pseudonymous/);
});

test("VALIDATION: corrupt / unsupported / oversized files are refused safely — metadata kept, no stored binary, no retry", async () => {
  const kit = contributionKit({ imageLimits: { maxBytes: 40_000, minSide: 16, maxSide: 12000, maxPixels: 60_000_000 } });
  const { submission, send } = start(kit);
  for (const f of ["corrupt_truncated.jpg", "not_an_image.jpg", "fake.gif", "menu_clean.jpg"]) send({ file: f });
  await kit.ingestion.processPending();
  const jobs = kit.db.prepare(`SELECT mm.external_file_id AS f, j.status, j.attempts, j.last_error FROM kb_ingest_jobs j JOIN kb_ingest_message_media mm ON mm.id = j.item WHERE j.stage = 'media_fetch' ORDER BY j.id`).all();
  const by = Object.fromEntries(jobs.map((j) => [j.f, j]));
  assert.equal(by["corrupt_truncated.jpg"].status, "FAILED");
  assert.match(by["corrupt_truncated.jpg"].last_error, /image rejected: truncated/);
  assert.match(by["not_an_image.jpg"].last_error, /image rejected: unsupported_type/);
  assert.match(by["fake.gif"].last_error, /image rejected: unsupported_type/);
  assert.match(by["menu_clean.jpg"].last_error, /image rejected: too_large/);
  for (const j of jobs) assert.equal(j.attempts, 1, "a permanent refusal is not retried");
  assert.equal(kit.db.prepare(`SELECT COUNT(*) AS n FROM kb_ingest_media`).get().n, 0, "nothing invalid is stored");
  assert.equal(kit.store.messages(submission.id).length, 4, "the submission metadata is kept");
  assert.equal(kit.store.progress(submission.id).failed.length, 4);
});

test("IMAGE CHECK: real type from the bytes, dimensions from the header, integrity", () => {
  assert.deepEqual(
    (({ ok, mimeType, width, height }) => ({ ok, mimeType, width, height }))(checkImage(fixture("menu_clean.jpg"))),
    { ok: true, mimeType: "image/jpeg", width: 900, height: 700 }
  );
  assert.equal(checkImage(fixture("menu_small.png")).mimeType, "image/png");
  assert.equal(checkImage(fixture("menu_small.png"), { claimedMimeType: "image/jpeg" }).ok, true, "a wrong claimed type does not matter, the bytes do");
  assert.equal(checkImage(fixture("corrupt_truncated.jpg")).reason, "truncated");
  assert.equal(checkImage(fixture("not_an_image.jpg")).reason, "unsupported_type");
  assert.equal(checkImage(Buffer.alloc(0)).reason, "empty");
  assert.equal(checkImage(fixture("menu_clean.jpg"), { limits: { maxBytes: 1e9, minSide: 16, maxSide: 800, maxPixels: 1e9 } }).reason, "dimensions");
  // a PNG without IEND
  const png = fixture("menu_small.png");
  assert.equal(checkImage(png.subarray(0, png.length - 20)).reason, "truncated");
});

test("MIGRATION: 005 + 008 are additive — the Knowledge Group path writes as before; published knowledge untouched", async () => {
  const kit = contributionKit();
  const published = () => ["kb_merchants", "kb_merchant_products", "kb_product_prices", "kb_merchant_locations"].map((t) => kit.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n);
  const before = published();
  const g = kit.ingestion.receive({ channel: "telegram", chatId: "-100777", messageId: "1", senderId: "501", senderName: "Tester", text: "Quán Bún Cá Cô Ba bún cá 35k", raw: {} });
  const row = kit.db.prepare(`SELECT * FROM kb_ingest_messages WHERE id = ?`).get(g.id);
  assert.equal(row.source_type, "knowledge_group");
  assert.equal(row.text, "Quán Bún Cá Cô Ba bún cá 35k");
  await kit.ingestion.processPending();
  assert.equal(kit.db.prepare(`SELECT COUNT(*) AS n FROM kb_ingest_candidates WHERE message_id = ?`).get(g.id).n, 1, "group candidates are created at once, as before");
  assert.deepEqual(published(), before);
  const names = kit.db.prepare(`SELECT name FROM kb_schema_migrations ORDER BY name`).all().map((r) => r.name);
  assert.ok(names.includes("005_knowledge_ingestion.sql") && names.includes("008_customer_contributions.sql"));
});
