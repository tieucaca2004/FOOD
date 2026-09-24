import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTestPlatform } from "../helpers/testPlatform.js";

const INPUT = { merchantId: "ATOMIC001", name: "Quán Atomic", slug: "quan-atomic", module: "generic" };

function rowCounts(platform, merchantId) {
  return {
    merchants: platform.db.prepare("SELECT COUNT(*) AS n FROM merchants WHERE merchant_id = ?").get(merchantId).n,
    subscriptions: platform.db.prepare("SELECT COUNT(*) AS n FROM merchant_subscriptions WHERE merchant_id = ?").get(merchantId).n,
  };
}

test("BUG-002: an unknown plan leaves no merchant behind, and a corrected retry succeeds", () => {
  const platform = buildTestPlatform({ withAtieu: false });
  assert.throws(() => platform.services.merchants.onboard({ ...INPUT, planId: "no-such-plan" }), { code: "PLAN_NOT_FOUND" });
  assert.deepEqual(rowCounts(platform, INPUT.merchantId), { merchants: 0, subscriptions: 0 });

  const merchant = platform.services.merchants.onboard({ ...INPUT, planId: "free" });
  assert.equal(merchant.status, "PENDING");
  assert.deepEqual(rowCounts(platform, INPUT.merchantId), { merchants: 1, subscriptions: 1 });
});

test("BUG-002: a failure while starting the subscription rolls back the merchant row too", () => {
  const platform = buildTestPlatform({ withAtieu: false });
  const originalStartTrial = platform.repos.subscriptions.startTrial.bind(platform.repos.subscriptions);
  platform.repos.subscriptions.startTrial = () => {
    throw new Error("SQLITE_BUSY: database is locked");
  };
  assert.throws(() => platform.services.merchants.onboard(INPUT), /SQLITE_BUSY/);
  assert.deepEqual(rowCounts(platform, INPUT.merchantId), { merchants: 0, subscriptions: 0 });

  platform.repos.subscriptions.startTrial = originalStartTrial;
  platform.services.merchants.onboard(INPUT);
  assert.deepEqual(rowCounts(platform, INPUT.merchantId), { merchants: 1, subscriptions: 1 });
});

test("BUG-002: a failure creating the merchant row writes no subscription", () => {
  const platform = buildTestPlatform({ withAtieu: false });
  platform.services.merchants.onboard(INPUT);
  // Same slug, different id: the merchants.slug UNIQUE constraint rejects it.
  assert.throws(() => platform.services.merchants.onboard({ ...INPUT, merchantId: "ATOMIC002" }));
  assert.deepEqual(rowCounts(platform, "ATOMIC002"), { merchants: 0, subscriptions: 0 });
});

test("successful onboarding is unchanged: PENDING merchant with a TRIAL subscription", () => {
  const platform = buildTestPlatform({ withAtieu: false });
  const merchant = platform.services.merchants.onboard(INPUT);
  assert.equal(merchant.status, "PENDING");
  assert.equal(platform.repos.subscriptions.getActiveByMerchant(INPUT.merchantId).status, "TRIAL");
});
