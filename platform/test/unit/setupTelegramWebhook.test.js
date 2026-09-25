// platform/scripts/setup-telegram-webhook.js: validation, the exact Bot API
// calls it makes, and that neither the token nor the secret is ever printed.
// All Telegram calls go to an injected fake; nothing leaves the process.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { run, buildWebhookUrl, DEFAULT_WEBHOOK_PATH } from "../../scripts/setup-telegram-webhook.js";
import { platformConfig } from "../../config.js";

const TOKEN = "123456789:" + "A".repeat(35);
const SECRET = "test-only-webhook-secret-" + "b".repeat(20);
const BASE = "https://telegram.food.example";
const EXPECTED_URL = `https://telegram.food.example${DEFAULT_WEBHOOK_PATH}`;

function fakeTelegram({ currentUrl = EXPECTED_URL, setOk = true, lastError = null } = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const method = String(url).split("/").pop();
    calls.push({ url: String(url), method, body: JSON.parse(options.body) });
    let body;
    if (method === "setWebhook") body = setOk ? { ok: true, result: true, description: "Webhook was set" } : { ok: false, error_code: 400, description: "Bad Request: bad webhook: HTTPS url must be provided" };
    else body = { ok: true, result: { url: currentUrl, pending_update_count: 2, has_custom_certificate: false, ...(lastError ? { last_error_date: 1700000000, last_error_message: lastError } : {}) } };
    return new Response(JSON.stringify(body), { status: body.ok ? 200 : 400, headers: { "content-type": "application/json" } });
  };
  return { calls, fetchImpl };
}

async function runWith({ argv = [], env = {}, fake = fakeTelegram() } = {}) {
  const lines = [];
  const code = await run({
    argv,
    env: { PLATFORM_TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_WEBHOOK_SECRET: SECRET, TELEGRAM_WEBHOOK_BASE_URL: BASE, ...env },
    fetchImpl: fake.fetchImpl,
    out: (l) => lines.push(l),
  });
  const output = lines.join("\n");
  assert.ok(!output.includes(TOKEN) && !output.includes(TOKEN.split(":")[1]), "token printed");
  assert.ok(!output.includes(SECRET), "secret printed");
  return { code, output, calls: fake.calls };
}

test("the default webhook path matches the server's", () => {
  assert.equal(DEFAULT_WEBHOOK_PATH, "/api/platform/webhook/telegram");
  if (!process.env.TELEGRAM_WEBHOOK_PATH) assert.equal(platformConfig.telegramWebhookPath, DEFAULT_WEBHOOK_PATH);
});

test("registers the fixed URL with the secret, keeps pending updates, then verifies it", async () => {
  const { code, output, calls } = await runWith();
  assert.equal(code, 0, output);
  assert.deepEqual(calls.map((c) => c.method), ["setWebhook", "getWebhookInfo"]);
  assert.deepEqual(calls[0].body, { url: EXPECTED_URL, secret_token: SECRET, drop_pending_updates: false });
  assert.ok(calls.every((c) => c.url.startsWith("https://api.telegram.org/bot")));
  assert.match(output, /setWebhook: OK/);
  assert.match(output, /\(matches\)/);
  assert.match(output, /Bot token: PRESENT \| Webhook secret: PRESENT/);
});

test("--check only reads the webhook and fails when it points elsewhere", async () => {
  const ok = await runWith({ argv: ["--check"] });
  assert.equal(ok.code, 0);
  assert.deepEqual(ok.calls.map((c) => c.method), ["getWebhookInfo"]);

  const stale = await runWith({ argv: ["--check"], fake: fakeTelegram({ currentUrl: "https://old-name.trycloudflare.com/api/platform/webhook/telegram", lastError: "Wrong response from the webhook: 530" }) });
  assert.equal(stale.code, 1);
  assert.match(stale.output, /DOES NOT MATCH/);
  assert.match(stale.output, /530/);
});

test("--dry-run validates without any network call", async () => {
  const { code, output, calls } = await runWith({ argv: ["--dry-run"] });
  assert.equal(code, 0);
  assert.equal(calls.length, 0);
  assert.match(output, new RegExp(EXPECTED_URL.replace(/[./]/g, "\\$&")));
});

test("a Telegram refusal is reported and exits non-zero", async () => {
  const { code, output } = await runWith({ fake: fakeTelegram({ setOk: false }) });
  assert.equal(code, 1);
  assert.match(output, /setWebhook failed/);
});

test("missing or malformed settings stop before any network call", async () => {
  const cases = [
    [{ PLATFORM_TELEGRAM_BOT_TOKEN: "" }, /PLATFORM_TELEGRAM_BOT_TOKEN is not set/],
    [{ PLATFORM_TELEGRAM_BOT_TOKEN: "not-a-token" }, /does not look like a Bot API token/],
    [{ TELEGRAM_WEBHOOK_SECRET: "" }, /TELEGRAM_WEBHOOK_SECRET is not set/],
    [{ TELEGRAM_WEBHOOK_SECRET: "has spaces in it" }, /1-256 characters/],
    [{ TELEGRAM_WEBHOOK_BASE_URL: "" }, /TELEGRAM_WEBHOOK_BASE_URL is not set/],
  ];
  for (const [env, message] of cases) {
    const fake = fakeTelegram();
    const { code, output } = await runWith({ env, fake });
    assert.equal(code, 1, JSON.stringify(env));
    assert.match(output, message);
    assert.equal(fake.calls.length, 0);
  }
});

test("the base URL must be a fixed public https hostname, never a Quick Tunnel", () => {
  assert.equal(buildWebhookUrl("https://telegram.food.example"), EXPECTED_URL);
  assert.equal(buildWebhookUrl("https://Telegram.Food.Example/"), EXPECTED_URL);
  const refused = [
    ["http://telegram.food.example", /https/],
    ["https://random-words-example.trycloudflare.com", /Quick Tunnel/],
    ["https://localhost", /public hostname/],
    ["https://127.0.0.1", /public hostname/],
    ["https://telegram.food.example/api/platform/webhook/telegram", /hostname only/],
    ["https://telegram.food.example:8443", /default HTTPS port/],
    ["https://user:pass@telegram.food.example", /credentials/],
    ["https://telegram.food.example/?x=1", /query/],
    ["not a url", /valid URL/],
  ];
  for (const [base, message] of refused) assert.throws(() => buildWebhookUrl(base), message, base);
});

test("run as a script with no .env values, it fails cleanly without printing anything secret", () => {
  const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../scripts/setup-telegram-webhook.js");
  const env = { ...process.env, PLATFORM_TELEGRAM_BOT_TOKEN: "", TELEGRAM_WEBHOOK_SECRET: "", TELEGRAM_WEBHOOK_BASE_URL: "" };
  const result = spawnSync(process.execPath, [script, "--dry-run"], { env, encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /PLATFORM_TELEGRAM_BOT_TOKEN is not set/);
});
