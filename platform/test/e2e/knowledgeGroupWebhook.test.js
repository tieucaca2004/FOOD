// Knowledge Group over the (simulated) Telegram webhook: the group's messages are EVIDENCE, never a
// customer conversation. Knowledge rows are a SYNTHETIC FIXTURE in a temp DB; no bot token (no network).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildTestPlatform, startServer, baseUrl } from "../helpers/testPlatform.js";
import { nhaTrangKnowledge } from "../helpers/nhaTrangKnowledge.js";
import { createKnowledgeIngest, telegramGroupEnvelope } from "../../services/knowledgeIngestAdapter.js";
import { platformConfig } from "../../config.js";

platformConfig.telegramBotToken = "";
const TEST_SECRET = "test-telegram-secret-value";
const GROUP = -100777;

async function withGroup(fn, { ingest = true } = {}) {
  const originalSecret = platformConfig.telegramWebhookSecret;
  platformConfig.telegramWebhookSecret = TEST_SECRET;
  const knowledgeIngest = ingest ? createKnowledgeIngest({ dbPath: nhaTrangKnowledge(), rawRoot: fs.mkdtempSync(path.join(os.tmpdir(), "kg-raw-")), groupChatIds: [String(GROUP)], botToken: "" }) : null;
  const platform = buildTestPlatform({ withAtieu: true, atieuEngine: "generic", knowledgeIngest });
  const server = await startServer(platform.app);
  let seq = 0;
  const post = async (message, { secret = TEST_SECRET, updateId = null, edited = false } = {}) => {
    const id = updateId ?? ++seq;
    const res = await fetch(`${baseUrl(server)}${platformConfig.telegramWebhookPath}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(secret && { "x-telegram-bot-api-secret-token": secret }) },
      body: JSON.stringify({ update_id: id, [edited ? "edited_message" : "message"]: { message_id: id, date: 1790000000, ...message } }),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const group = { id: GROUP, type: "supergroup", title: "FOOD Knowledge" };
  const from = { id: 501, is_bot: false, first_name: "Editor" };
  const platformRows = () => ["platform_customers", "platform_messages", "merchant_carts", "orders"].map((t) => platform.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n);
  try {
    await fn({ post, group, from, knowledgeIngest, platformRows });
  } finally {
    server.close();
    knowledgeIngest?.close();
    platformConfig.telegramWebhookSecret = originalSecret;
  }
}

test("KNOWLEDGE GROUP: a group message is stored as evidence and queued — no customer, no reply, idempotent", async () => {
  await withGroup(async ({ post, group, from, knowledgeIngest, platformRows }) => {
    const before = platformRows();
    const first = await post({ chat: group, from, text: "Quán Bún Cá Mẫu bún cá 50k" }, { updateId: 41 });
    assert.equal(first.status, 200);
    assert.deepEqual(first.body, { status: "ingested", channel: "telegram", ingest_status: "received" });
    const again = await post({ chat: group, from, text: "Quán Bún Cá Mẫu bún cá 50k" }, { updateId: 41 });
    assert.equal(again.body.ingest_status, "duplicate");
    await knowledgeIngest.whenIdle();
    const [c] = knowledgeIngest.ingestion.listCandidates();
    assert.deepEqual([c.kind, c.normalized_value, c.change, c.status], ["price", "50000", "CONFLICT", "review"]);
    assert.deepEqual(platformRows(), before); // the group is not a customer conversation
  });
});

test("KNOWLEDGE GROUP: a photo without a way to fetch it is kept and waits; the secret is still required", async () => {
  await withGroup(async ({ post, group, from, knowledgeIngest }) => {
    const r = await post({ chat: group, from, caption: "Menu mới", photo: [{ file_id: "small", width: 90, height: 90 }, { file_id: "large", width: 1280, height: 960 }] });
    assert.equal(r.body.status, "ingested");
    await knowledgeIngest.whenIdle();
    const db = knowledgeIngest.ingestion.db;
    assert.equal(db.prepare(`SELECT external_file_id FROM kb_ingest_message_media`).get().external_file_id, "large");
    assert.equal(db.prepare(`SELECT status FROM kb_ingest_jobs WHERE stage = 'media_fetch'`).get().status, "WAITING_PROVIDER");
    const denied = await post({ chat: group, from, text: "Quán Bún Cá Mẫu bún cá 1k" }, { secret: null });
    assert.ok(denied.status >= 400);
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM kb_ingest_messages`).get().n, 1);
  });
});

test("OTHER CHATS unchanged: private chats and non-listed groups keep the customer flow; ingestion off = as before", async () => {
  await withGroup(async ({ post, from, knowledgeIngest }) => {
    const priv = await post({ chat: { id: 501, type: "private" }, from, text: "tìm hủ tiếu" });
    assert.equal(priv.body.status, "processed");
    assert.match(priv.body.reply_text, /HỦ TIẾU XÀO A TIỂU/);
    const otherGroup = await post({ chat: { id: -100999, type: "group" }, from, text: "tìm hủ tiếu" });
    assert.equal(otherGroup.body.status, "processed");
    assert.equal(knowledgeIngest.ingestion.db.prepare(`SELECT COUNT(*) AS n FROM kb_ingest_messages`).get().n, 0);
  });
  await withGroup(
    async ({ post, group, from }) => {
      assert.equal((await post({ chat: group, from, text: "tìm hủ tiếu" })).body.status, "processed");
    },
    { ingest: false }
  );
});

test("ENVELOPE: largest photo, image/PDF documents, edits are new evidence, non-group and empty updates are ignored", () => {
  const base = { message_id: 7, date: 1790000000, chat: { id: -1, type: "group" }, from: { id: 9, first_name: "A", last_name: "B" } };
  const photo = telegramGroupEnvelope({ update_id: 1, message: { ...base, caption: "x", photo: [{ file_id: "s", file_size: 10 }, { file_id: "l", file_size: 900 }] } });
  assert.deepEqual(photo.media, [{ type: "photo", fileId: "l", mimeType: "image/jpeg" }]);
  assert.equal(photo.senderName, "A B");
  assert.equal(photo.sentAt, new Date(1790000000 * 1000).toISOString());
  const pdf = telegramGroupEnvelope({ update_id: 2, message: { ...base, document: { file_id: "d", mime_type: "application/pdf", file_name: "menu.pdf" } } });
  assert.deepEqual(pdf.media, [{ type: "document", fileId: "d", mimeType: "application/pdf", filename: "menu.pdf" }]);
  assert.equal(telegramGroupEnvelope({ update_id: 3, message: { ...base, document: { file_id: "z", mime_type: "application/zip" } } }), null);
  assert.equal(telegramGroupEnvelope({ update_id: 4, edited_message: { ...base, text: "sửa", edit_date: 1790000100 } }).messageId, "7:edit:1790000100");
  assert.equal(telegramGroupEnvelope({ update_id: 5, message: { ...base, chat: { id: 9, type: "private" }, text: "hi" } }), null);
  assert.equal(telegramGroupEnvelope({ update_id: 6, message: { ...base } }), null);
});

test("MEDIA FETCH: the bot token is used to fetch but never appears in errors", async () => {
  const token = "123456:SECRET-TOKEN-VALUE";
  const fetchImpl = async (url) => {
    if (String(url).includes("getFile")) return { ok: true, status: 200, json: async () => ({ ok: true, result: { file_path: "photos/file_1.jpg" } }) };
    throw new Error(`network error at ${url}`); // an error that would carry the URL (and the token)
  };
  const ki = createKnowledgeIngest({ dbPath: nhaTrangKnowledge(), rawRoot: fs.mkdtempSync(path.join(os.tmpdir(), "kg-raw-")), groupChatIds: ["-1"], botToken: token, fetchImpl });
  try {
    ki.receive({ update_id: 1, message: { message_id: 1, date: 1, chat: { id: -1, type: "group" }, from: { id: 2 }, photo: [{ file_id: "f1" }] } });
    await ki.whenIdle();
    const job = ki.ingestion.db.prepare(`SELECT * FROM kb_ingest_jobs WHERE stage = 'media_fetch'`).get();
    assert.equal(job.status, "RECEIVED"); // will retry
    assert.ok(!job.last_error.includes(token));
    assert.match(job.last_error, /<token>/);
  } finally {
    ki.close();
  }
});
