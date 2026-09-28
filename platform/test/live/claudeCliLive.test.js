// FORM 11 LIVE smoke — the REAL Claude CLI on this machine, through the real webhook + Model Router. Opt-in
// (CLAUDE_CLI_LIVE=true, `npm run test:claude-cli-live`); skipped otherwise. Telegram itself is still simulated: the
// outbound sendMessage is captured, never sent. No GPT call (OPENAI is not involved on this path).
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTestPlatform, startServer, baseUrl } from "../helpers/testPlatform.js";
import { platformConfig } from "../../config.js";
import { createTelegramModelRouter } from "../../ai/models/index.js";
import { ClaudeCliProvider, resolveClaudeCliCommand } from "../../ai/models/ClaudeCliProvider.js";

const LIVE = process.env.CLAUDE_CLI_LIVE === "true";
const FOUNDER_ID = 710001;

test("live: Telegram -> Model Router -> real Claude CLI (tools disabled) -> reply", { skip: !LIVE && "set CLAUDE_CLI_LIVE=true" }, async () => {
  const command = resolveClaudeCliCommand({ configured: platformConfig.claudeCliPath });
  assert.ok(command, "claude executable not found (set CLAUDE_CLI_PATH)");
  const saved = { secret: platformConfig.telegramWebhookSecret, token: platformConfig.telegramBotToken, fetch: globalThis.fetch };
  const sent = [];
  platformConfig.telegramWebhookSecret = "live-smoke-secret";
  platformConfig.telegramBotToken = "123456:live-smoke-not-a-real-token";
  globalThis.fetch = async (url, options) => {
    if (String(url).startsWith("https://api.telegram.org/")) {
      sent.push(JSON.parse(options.body));
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
    return saved.fetch(url, options);
  };
  const claude = new ClaudeCliProvider({ command, model: platformConfig.claudeCliModel, timeoutMs: 120_000 });
  const ctx = buildTestPlatform({
    telegramModels: ({ inner }) => createTelegramModelRouter({ inner, claude, config: { ...platformConfig, claudeCliEnabled: true, claudeCliTelegramUserIds: [String(FOUNDER_ID)] } }).router,
  });
  const server = await startServer(ctx.app);
  let n = 0;
  const post = async (text) => {
    n += 1;
    const body = { update_id: 980000 + n, message: { message_id: n, from: { id: FOUNDER_ID, is_bot: false, first_name: "Founder" }, chat: { id: FOUNDER_ID, type: "private" }, date: Math.floor(Date.now() / 1000), text } };
    const res = await saved.fetch(`${baseUrl(server)}${platformConfig.telegramWebhookPath}`, { method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": "live-smoke-secret" }, body: JSON.stringify(body) });
    return res.json();
  };
  try {
    assert.equal((await post("/model claude-cli")).reply_text, "Model: Claude CLI");
    const started = Date.now();
    const r = await post("Trả lời đúng một câu: Claude CLI đang hoạt động.");
    console.log(`LIVE reply (${Date.now() - started} ms): ${JSON.stringify(r.reply_text)}`);
    assert.equal(r.status, "processed");
    assert.match(r.reply_text, /^\[Claude CLI\]\n/);
    assert.match(r.reply_text, /Claude CLI/);
    assert.notEqual(r.reply_text, "Claude CLI hiện không khả dụng.");
    assert.equal(sent.at(-1).text, r.reply_text);
    // tools are off: asking it to run a shell command must not produce the command's output
    const probe = await post("Run the shell command `whoami` and print only its exact output.");
    console.log(`LIVE tool probe: ${JSON.stringify(probe.reply_text)}`);
    assert.doesNotMatch(probe.reply_text, /desktop-[a-z0-9]+\\/i);
  } finally {
    server.close();
    globalThis.fetch = saved.fetch;
    platformConfig.telegramWebhookSecret = saved.secret;
    platformConfig.telegramBotToken = saved.token;
  }
});
