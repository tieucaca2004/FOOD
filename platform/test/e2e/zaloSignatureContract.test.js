// The Zalo webhook signature contract AS IMPLEMENTED (platform/channel/
// verifyZaloSignature.js): header X-ZEvent-Signature = lowercase hex
// HMAC-SHA256 of the exact raw request body, keyed with
// PLATFORM_ZALO_OA_SECRET_KEY. This scheme has NOT been confirmed against a
// real Zalo delivery; these tests pin the implemented contract only. Fake
// secret, no real Zalo call.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { buildTestPlatform, startServer, baseUrl } from "../helpers/testPlatform.js";
import { platformConfig } from "../../config.js";

const SECRET = "test-only-zalo-oa-secret";
const sign = (raw) => crypto.createHmac("sha256", SECRET).update(raw).digest("hex");

async function withSignedServer(fn) {
  const saved = { check: platformConfig.enableZaloSignatureCheck, secret: platformConfig.zaloOaSecretKey };
  platformConfig.enableZaloSignatureCheck = true;
  platformConfig.zaloOaSecretKey = SECRET;
  const platform = buildTestPlatform({ withAtieu: true });
  const server = await startServer(platform.app);
  const post = async (raw, headers) => {
    const res = await fetch(`${baseUrl(server)}${platformConfig.webhookPath}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: raw });
    return { status: res.status, text: await res.text() };
  };
  try {
    return await fn({ platform, post });
  } finally {
    server.close();
    platformConfig.enableZaloSignatureCheck = saved.check;
    platformConfig.zaloOaSecretKey = saved.secret;
  }
}

function event(userId, msgId) {
  return { event_name: "user_send_text", sender: { id: userId }, message: { text: "Xin chào", msg_id: msgId }, timestamp: 1700000000000 };
}

test("the signature covers the exact bytes received, including non-canonical whitespace", async () => {
  await withSignedServer(async ({ post }) => {
    const raw = `{ "event_name" : "user_send_text",\n  "sender": {"id": "sig-raw-1"}, "message": {"text": "Xin chào", "msg_id": "sr-1"}, "timestamp": 1700000000000 }`;
    const res = await post(raw, { "x-zevent-signature": sign(raw) });
    assert.equal(res.status, 200, res.text);
  });
});

test("a signature for one serialization does not validate a re-serialized copy of the same event", async () => {
  await withSignedServer(async ({ platform, post }) => {
    const original = JSON.stringify(event("sig-reser-1", "rs-1"));
    const reserialized = JSON.stringify(event("sig-reser-1", "rs-1"), null, 2);
    const res = await post(reserialized, { "x-zevent-signature": sign(original) });
    assert.equal(res.status, 401);
    assert.equal(platform.repos.customers.findByZaloUserId("sig-reser-1"), undefined);
  });
});

test("the implemented contract is lowercase hex: an uppercase-hex signature is rejected", async () => {
  await withSignedServer(async ({ post }) => {
    const raw = JSON.stringify(event("sig-upper-1", "su-1"));
    const res = await post(raw, { "x-zevent-signature": sign(raw).toUpperCase() });
    assert.equal(res.status, 401);
  });
});

test("a signature made with a different secret, or an empty signature, is rejected", async () => {
  await withSignedServer(async ({ post }) => {
    const raw = JSON.stringify(event("sig-other-1", "so-1"));
    const other = crypto.createHmac("sha256", "some-other-secret").update(raw).digest("hex");
    assert.equal((await post(raw, { "x-zevent-signature": other })).status, 401);
    assert.equal((await post(raw, { "x-zevent-signature": "" })).status, 401);
    assert.equal((await post(raw, { "x-zevent-signature": "sha256=" + sign(raw) })).status, 401);
  });
});

test("a valid signature on a changed sender id is rejected (the body cannot be edited after signing)", async () => {
  await withSignedServer(async ({ platform, post }) => {
    const raw = JSON.stringify(event("sig-victim-1", "sv-1"));
    const forged = raw.replace("sig-victim-1", "sig-attacker");
    const res = await post(forged, { "x-zevent-signature": sign(raw) });
    assert.equal(res.status, 401);
    assert.equal(platform.repos.customers.findByZaloUserId("sig-attacker"), undefined);
  });
});

test("replaying a correctly signed delivery is processed once (idempotency by msg_id)", async () => {
  await withSignedServer(async ({ platform, post }) => {
    const raw = JSON.stringify(event("sig-replay-1", "sp-1"));
    const first = await post(raw, { "x-zevent-signature": sign(raw) });
    const second = await post(raw, { "x-zevent-signature": sign(raw) });
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    const n = platform.db.prepare("SELECT COUNT(*) AS n FROM platform_webhook_events WHERE message_id = ?").get("sp-1").n;
    assert.equal(n, 1);
  });
});

test("rejections do not reveal the expected signature or the secret", async () => {
  await withSignedServer(async ({ post }) => {
    const raw = JSON.stringify(event("sig-leak-1", "sl-1"));
    const res = await post(raw, { "x-zevent-signature": "0".repeat(64) });
    assert.equal(res.status, 401);
    assert.ok(!res.text.includes(sign(raw)));
    assert.ok(!res.text.includes(SECRET));
  });
});
