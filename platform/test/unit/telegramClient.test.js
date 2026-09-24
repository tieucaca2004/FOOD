import { test } from "node:test";
import assert from "node:assert/strict";
import { sendTelegramMessage } from "../../channel/telegram/telegramClient.js";
import { platformConfig } from "../../config.js";

const FAKE_TOKEN = "123456:test-platform-bot-token";

function fakeResponse(status, data) {
  return { ok: status >= 200 && status < 300, status, json: async () => data };
}

function recordingFetch(response) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) });
    if (response instanceof Error) throw response;
    return response;
  };
  return { calls, fetchImpl };
}

// Captures everything the logger writes, so tests can prove the token never reaches it.
async function withTokenAndCapturedLogs(token, fn) {
  const original = { token: platformConfig.telegramBotToken, log: console.log, warn: console.warn, error: console.error };
  const lines = [];
  platformConfig.telegramBotToken = token;
  console.log = console.warn = console.error = (line) => lines.push(String(line));
  try {
    return await fn(lines);
  } finally {
    platformConfig.telegramBotToken = original.token;
    console.log = original.log;
    console.warn = original.warn;
    console.error = original.error;
  }
}

test("sends to the Bot API sendMessage URL with chat_id and text as JSON", async () => {
  await withTokenAndCapturedLogs(FAKE_TOKEN, async () => {
    const { calls, fetchImpl } = recordingFetch(fakeResponse(200, { ok: true, result: { message_id: 1 } }));
    await sendTelegramMessage({ chatId: "-1001234567890", text: "Xin chào" }, { fetchImpl });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `https://api.telegram.org/bot${FAKE_TOKEN}/sendMessage`);
    assert.equal(calls[0].options.method, "POST");
    assert.equal(calls[0].options.headers["content-type"], "application/json");
    assert.deepEqual(calls[0].body, { chat_id: "-1001234567890", text: "Xin chào" });
  });
});

test("a successful Telegram response returns { ok: true }", async () => {
  await withTokenAndCapturedLogs(FAKE_TOKEN, async () => {
    const { fetchImpl } = recordingFetch(fakeResponse(200, { ok: true, result: {} }));
    assert.deepEqual(await sendTelegramMessage({ chatId: "42", text: "hi" }, { fetchImpl }), { ok: true });
  });
});

test("a non-2xx Telegram response is reported, not thrown, and the token is never logged", async () => {
  await withTokenAndCapturedLogs(FAKE_TOKEN, async (lines) => {
    const { fetchImpl } = recordingFetch(fakeResponse(400, { ok: false, error_code: 400, description: "Bad Request: chat not found" }));
    const result = await sendTelegramMessage({ chatId: "42", text: "hi" }, { fetchImpl });

    assert.deepEqual(result, { ok: false, status: 400, error: "Bad Request: chat not found" });
    assert.ok(lines.length > 0);
    assert.ok(!lines.join("\n").includes(FAKE_TOKEN));
  });
});

test("a 2xx response whose body is not { ok: true } is treated as a failure", async () => {
  await withTokenAndCapturedLogs(FAKE_TOKEN, async () => {
    const { fetchImpl } = recordingFetch({ ok: true, status: 200, json: async () => { throw new SyntaxError("bad json"); } });
    const result = await sendTelegramMessage({ chatId: "42", text: "hi" }, { fetchImpl });
    assert.equal(result.ok, false);
    assert.equal(result.error, "HTTP 200");
  });
});

test("a network failure is reported, not thrown, with the token redacted from the error and the logs", async () => {
  await withTokenAndCapturedLogs(FAKE_TOKEN, async (lines) => {
    const networkError = new TypeError(`fetch failed for https://api.telegram.org/bot${FAKE_TOKEN}/sendMessage`);
    const { fetchImpl } = recordingFetch(networkError);
    const result = await sendTelegramMessage({ chatId: "42", text: "hi" }, { fetchImpl });

    assert.equal(result.ok, false);
    assert.ok(!result.error.includes(FAKE_TOKEN));
    assert.ok(result.error.includes("<redacted>"));
    assert.ok(!lines.join("\n").includes(FAKE_TOKEN));
  });
});

test("a timeout is reported as 'timeout'", async () => {
  await withTokenAndCapturedLogs(FAKE_TOKEN, async () => {
    const abort = new Error("aborted");
    abort.name = "AbortError";
    const { fetchImpl } = recordingFetch(abort);
    assert.deepEqual(await sendTelegramMessage({ chatId: "42", text: "hi" }, { fetchImpl }), { ok: false, error: "timeout" });
  });
});

test("with no PLATFORM_TELEGRAM_BOT_TOKEN configured, nothing is sent", async () => {
  await withTokenAndCapturedLogs("", async () => {
    const { calls, fetchImpl } = recordingFetch(fakeResponse(200, { ok: true }));
    const result = await sendTelegramMessage({ chatId: "42", text: "hi" }, { fetchImpl });
    assert.equal(calls.length, 0);
    assert.deepEqual(result, { ok: false, error: "PLATFORM_TELEGRAM_BOT_TOKEN not configured" });
  });
});
