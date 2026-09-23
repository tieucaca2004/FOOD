import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTestPlatform } from "../helpers/testPlatform.js";

function platformWithMerchant() {
  return buildTestPlatform({ withAtieu: false, genericFixtureMerchants: ["MERCHANT002"] });
}

test("issueApiKey mints a key and its hash resolves back to the correct merchant", () => {
  const platform = platformWithMerchant();
  const { apiKey, merchantId, merchantUserId } = platform.services.merchantAuth.issueApiKey("MERCHANT002");

  assert.equal(merchantId, "MERCHANT002");
  assert.ok(typeof apiKey === "string" && apiKey.startsWith("mk_"));
  assert.ok(merchantUserId > 0);

  const resolved = platform.services.merchantAuth.verifyApiKey(apiKey);
  assert.equal(resolved.merchantId, "MERCHANT002");
  assert.equal(resolved.merchantUserId, merchantUserId);
});

test("issueApiKey never stores the plaintext key — only its hash", () => {
  const platform = platformWithMerchant();
  const { apiKey } = platform.services.merchantAuth.issueApiKey("MERCHANT002");

  const rows = platform.db.prepare("SELECT api_key_hash FROM merchant_users WHERE merchant_id = ?").all("MERCHANT002");
  assert.equal(rows.length, 1);
  assert.notEqual(rows[0].api_key_hash, apiKey);
  assert.equal(rows[0].api_key_hash.length, 64); // sha256 hex digest
});

test("issueApiKey for a nonexistent merchant is rejected with MERCHANT_NOT_FOUND", () => {
  const platform = buildTestPlatform({ withAtieu: false });
  assert.throws(() => platform.services.merchantAuth.issueApiKey("NOPE"), (err) => {
    assert.equal(err.code, "MERCHANT_NOT_FOUND");
    return true;
  });
});

test("issuing a second key for the same merchant rotates it — the old key stops working", () => {
  const platform = platformWithMerchant();
  const first = platform.services.merchantAuth.issueApiKey("MERCHANT002");
  const second = platform.services.merchantAuth.issueApiKey("MERCHANT002");

  assert.notEqual(first.apiKey, second.apiKey);
  assert.equal(first.merchantUserId, second.merchantUserId); // same owner user, key rotated in place

  assert.throws(() => platform.services.merchantAuth.verifyApiKey(first.apiKey), (err) => {
    assert.equal(err.code, "UNAUTHENTICATED");
    return true;
  });
  assert.doesNotThrow(() => platform.services.merchantAuth.verifyApiKey(second.apiKey));
});

test("verifyApiKey rejects a wrong/unknown key with a generic UNAUTHENTICATED error", () => {
  const platform = platformWithMerchant();
  platform.services.merchantAuth.issueApiKey("MERCHANT002");

  assert.throws(() => platform.services.merchantAuth.verifyApiKey("mk_totally_wrong_key"), (err) => {
    assert.equal(err.code, "UNAUTHENTICATED");
    assert.equal(err.status, 401);
    return true;
  });
});

test("verifyApiKey rejects malformed input (null/undefined/empty/object/number) without a raw driver error", () => {
  const platform = platformWithMerchant();
  for (const bad of [null, undefined, "", {}, [], 12345]) {
    assert.throws(() => platform.services.merchantAuth.verifyApiKey(bad), (err) => {
      assert.equal(err.code, "UNAUTHENTICATED");
      return true;
    }, `presentedKey=${JSON.stringify(bad)}`);
  }
});
