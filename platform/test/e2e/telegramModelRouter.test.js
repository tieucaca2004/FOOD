// FORM 11 — Telegram -> webhook controller (unchanged) -> Model Router -> Claude CLI adapter -> sendMessage.
// SIMULATED: Telegram-shaped JSON is POSTed to the real Express app; the outbound Bot API call is captured by a stubbed
// fetch (never the real api.telegram.org), and Claude CLI is the fake executable in test/fixtures (never real Claude).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildTestPlatform, startServer, baseUrl } from "../helpers/testPlatform.js";
import { platformConfig } from "../../config.js";
import { createTelegramModelRouter } from "../../ai/models/index.js";
import { ClaudeCliProvider } from "../../ai/models/ClaudeCliProvider.js";

const FAKE_CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../fixtures/fakeClaudeCli.js");
const SECRET = "test-telegram-secret-value";
const TOKEN = "123456:e2e-fake-bot-token";
const FOUNDER_ID = 700001;
const CUSTOMER_ID = 700002;
let updateId = 900000;

function update(userId, text) {
  updateId += 1;
  return { update_id: updateId, message: { message_id: updateId, from: { id: userId, is_bot: false, first_name: "T" }, chat: { id: userId, type: "private" }, date: Math.floor(Date.now() / 1000), text } };
}

async function withHarness(fn, { command = process.execPath } = {}) {
  const saved = { secret: platformConfig.telegramWebhookSecret, token: platformConfig.telegramBotToken, fetch: globalThis.fetch };
  platformConfig.telegramWebhookSecret = SECRET;
  platformConfig.telegramBotToken = TOKEN;
  const sent = [];
  const realFetch = saved.fetch;
  globalThis.fetch = async (url, options) => {
    if (String(url).startsWith("https://api.telegram.org/")) {
      sent.push({ url: String(url), body: JSON.parse(options.body) });
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
    return realFetch(url, options);
  };
  const claude = new ClaudeCliProvider({ command, prefixArgs: command === process.execPath ? [FAKE_CLI] : [], cwd: fs.mkdtempSync(path.join(os.tmpdir(), "food-claude-e2e-")), timeoutMs: 10_000 });
  const ctx = buildTestPlatform({
    telegramModels: ({ inner }) => createTelegramModelRouter({ inner, claude, config: { ...platformConfig, claudeCliEnabled: true, claudeCliTelegramUserIds: [String(FOUNDER_ID)] } }).router,
  });
  const server = await startServer(ctx.app);
  const post = async (userId, text) => {
    const res = await realFetch(`${baseUrl(server)}${platformConfig.telegramWebhookPath}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": SECRET },
      body: JSON.stringify(update(userId, text)),
    });
    return { status: res.status, body: await res.json() };
  };
  try {
    await fn({ post, sent, ctx });
  } finally {
    server.close();
    globalThis.fetch = saved.fetch;
    platformConfig.telegramWebhookSecret = saved.secret;
    platformConfig.telegramBotToken = saved.token;
  }
}

test("founder: /models, /model claude-cli, a message answered by Claude CLI and sent back to the chat", async () => {
  await withHarness(async ({ post, sent }) => {
    let r = await post(FOUNDER_ID, "/models");
    assert.equal(r.status, 200);
    assert.match(r.body.reply_text, /^Models:\n1\. FOOD Agent.*\n2\. Claude CLI/);

    r = await post(FOUNDER_ID, "/model claude-cli");
    assert.equal(r.body.reply_text, "Model: Claude CLI");

    r = await post(FOUNDER_ID, "Kiểm tra platform router");
    assert.equal(r.body.status, "processed");
    assert.equal(r.body.reply_text, "[Claude CLI]\necho: Kiểm tra platform router");
    assert.equal(r.body.respond_error, null);

    const last = sent.at(-1);
    assert.equal(last.body.chat_id, String(FOUNDER_ID));
    assert.equal(last.body.text, "[Claude CLI]\necho: Kiểm tra platform router");
    assert.equal(sent.length, 3);

    r = await post(FOUNDER_ID, "/model gpt-4o");
    assert.equal(r.body.reply_text, "Model: FOOD Agent");
  });
});

test("a regular customer is untouched: /models goes to the FOOD pipeline, never to Claude", async () => {
  await withHarness(async ({ post }) => {
    const r = await post(CUSTOMER_ID, "/models");
    assert.equal(r.body.status, "processed");
    assert.doesNotMatch(r.body.reply_text ?? "", /Claude CLI|Models:/);
    const r2 = await post(CUSTOMER_ID, "/model claude-cli");
    assert.doesNotMatch(r2.body.reply_text ?? "", /Model: Claude CLI/);
  });
});

test("Claude CLI missing: the founder gets the clear 'unavailable' reply, still a 200 for Telegram", async () => {
  await withHarness(
    async ({ post, sent }) => {
      await post(FOUNDER_ID, "/model claude-cli");
      const r = await post(FOUNDER_ID, "hello");
      assert.equal(r.status, 200);
      assert.equal(r.body.reply_text, "Claude CLI hiện không khả dụng.");
      assert.equal(sent.at(-1).body.text, "Claude CLI hiện không khả dụng.");
    },
    { command: path.join(os.tmpdir(), "no-such-claude.exe") }
  );
});
