// Phase 8: unit tests for platform/channel/verifyZaloSignature.js.
// BLOCKED/best-effort scheme (see that file's doc comment — could not be
// verified against real Zalo OA webhook delivery in this session, no
// network access). These tests prove the function's OWN documented
// contract behaves correctly, not that the scheme matches Zalo's real one.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { verifyPlatformZaloSignature } from "../../channel/verifyZaloSignature.js";
import { platformConfig } from "../../config.js";

function withSignatureConfig(overrides, fn) {
  const original = { enableZaloSignatureCheck: platformConfig.enableZaloSignatureCheck, zaloOaSecretKey: platformConfig.zaloOaSecretKey };
  Object.assign(platformConfig, overrides);
  try {
    return fn();
  } finally {
    Object.assign(platformConfig, original);
  }
}

test("explicitly disabled: any body/headers pass when enableZaloSignatureCheck is false", () => {
  withSignatureConfig({ enableZaloSignatureCheck: false, zaloOaSecretKey: "irrelevant" }, () => {
    assert.equal(verifyPlatformZaloSignature("anything", {}), true);
    assert.equal(verifyPlatformZaloSignature("", { "x-zevent-signature": "bogus" }), true);
  });
});

test("enabled + missing secret key: rejects safely rather than silently passing", () => {
  withSignatureConfig({ enableZaloSignatureCheck: true, zaloOaSecretKey: "" }, () => {
    assert.equal(verifyPlatformZaloSignature("body", { "x-zevent-signature": "abc" }), false);
  });
});

test("enabled + missing signature header: rejected", () => {
  withSignatureConfig({ enableZaloSignatureCheck: true, zaloOaSecretKey: "secret" }, () => {
    assert.equal(verifyPlatformZaloSignature("body", {}), false);
  });
});

test("enabled + correct HMAC-SHA256 signature: accepted", () => {
  withSignatureConfig({ enableZaloSignatureCheck: true, zaloOaSecretKey: "top-secret" }, () => {
    const rawBody = JSON.stringify({ event_name: "user_send_text" });
    const validSignature = crypto.createHmac("sha256", "top-secret").update(rawBody).digest("hex");
    assert.equal(verifyPlatformZaloSignature(rawBody, { "x-zevent-signature": validSignature }), true);
  });
});

test("enabled + wrong signature: rejected", () => {
  withSignatureConfig({ enableZaloSignatureCheck: true, zaloOaSecretKey: "top-secret" }, () => {
    const rawBody = JSON.stringify({ event_name: "user_send_text" });
    assert.equal(verifyPlatformZaloSignature(rawBody, { "x-zevent-signature": "0".repeat(64) }), false);
  });
});

test("enabled + tampered body (valid signature for a DIFFERENT body): rejected", () => {
  withSignatureConfig({ enableZaloSignatureCheck: true, zaloOaSecretKey: "top-secret" }, () => {
    const originalBody = JSON.stringify({ event_name: "user_send_text", message: { text: "hello" } });
    const signatureForOriginal = crypto.createHmac("sha256", "top-secret").update(originalBody).digest("hex");
    const tamperedBody = JSON.stringify({ event_name: "user_send_text", message: { text: "TAMPERED" } });
    assert.equal(verifyPlatformZaloSignature(tamperedBody, { "x-zevent-signature": signatureForOriginal }), false);
  });
});

test("enabled + malformed signature header (not valid hex, wrong length) never throws — fails closed", () => {
  withSignatureConfig({ enableZaloSignatureCheck: true, zaloOaSecretKey: "top-secret" }, () => {
    for (const bad of ["not-hex-!!!", "", "abc", "x".repeat(1000)]) {
      assert.equal(verifyPlatformZaloSignature("body", { "x-zevent-signature": bad }), false, `signature=${bad}`);
    }
  });
});
