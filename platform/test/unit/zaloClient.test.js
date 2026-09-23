// Phase 8: unit tests for platform/channel/zaloClient.js — never a real
// network call; `fetchImpl` is injected deterministically.
import { test } from "node:test";
import assert from "node:assert/strict";
import { sendPlatformTextMessage } from "../../channel/zaloClient.js";
import { platformConfig } from "../../config.js";

function withToken(token, fn) {
  const original = platformConfig.zaloAccessToken;
  platformConfig.zaloAccessToken = token;
  try {
    return fn();
  } finally {
    platformConfig.zaloAccessToken = original;
  }
}

function fakeFetch({ status = 200, body = {} } = {}) {
  const calls = [];
  const impl = async (url, options) => {
    calls.push({ url, options });
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
  impl.calls = calls;
  return impl;
}

test("without a configured access token, skips sending and reports a clean error — never calls fetch", async () => {
  await withToken("", async () => {
    const fetchImpl = fakeFetch();
    const result = await sendPlatformTextMessage("u1", "hi", { fetchImpl });
    assert.equal(result.ok, false);
    assert.match(result.error, /PLATFORM_ZALO_OA_ACCESS_TOKEN/);
    assert.equal(fetchImpl.calls.length, 0);
  });
});

test("successful send returns ok:true and posts the expected recipient/message shape", async () => {
  await withToken("test-token", async () => {
    const fetchImpl = fakeFetch({ status: 200, body: { message_id: "abc" } });
    const result = await sendPlatformTextMessage("u1", "Xin chào", { fetchImpl });
    assert.equal(result.ok, true);

    const call = fetchImpl.calls[0];
    assert.equal(call.options.method, "POST");
    assert.equal(call.options.headers.access_token, "test-token");
    const sentBody = JSON.parse(call.options.body);
    assert.deepEqual(sentBody, { recipient: { user_id: "u1" }, message: { text: "Xin chào" } });
  });
});

test("access token is sent as a header, never embedded in the request body", async () => {
  await withToken("super-secret-token", async () => {
    const fetchImpl = fakeFetch({ status: 200 });
    await sendPlatformTextMessage("u1", "hi", { fetchImpl });
    const sentBody = fetchImpl.calls[0].options.body;
    assert.ok(!sentBody.includes("super-secret-token"), "access token must never appear in the request body");
  });
});

test("a 4xx response is NOT retried — fails immediately", async () => {
  await withToken("test-token", async () => {
    const fetchImpl = fakeFetch({ status: 400, body: { message: "bad request" } });
    const result = await sendPlatformTextMessage("u1", "hi", { fetchImpl });
    assert.equal(result.ok, false);
    assert.equal(fetchImpl.calls.length, 1); // no retry on a definitive client error
  });
});

test("a 5xx response IS retried up to the configured limit, then fails cleanly", async () => {
  await withToken("test-token", async () => {
    const fetchImpl = fakeFetch({ status: 503, body: {} });
    const result = await sendPlatformTextMessage("u1", "hi", { fetchImpl });
    assert.equal(result.ok, false);
    assert.equal(fetchImpl.calls.length, platformConfig.zaloSendRetries);
  });
});

test("a network-level throw (e.g. timeout) is treated as a transient failure and retried, never crashes the caller", async () => {
  await withToken("test-token", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    };
    const result = await sendPlatformTextMessage("u1", "hi", { fetchImpl });
    assert.equal(result.ok, false);
    assert.equal(result.error, "timeout");
    assert.equal(calls, platformConfig.zaloSendRetries);
  });
});
