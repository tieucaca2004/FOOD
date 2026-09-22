import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTestPlatform } from "../helpers/testPlatform.js";

test("expireIfNeeded is a no-op while the subscription is still within its trial window", () => {
  const platform = buildTestPlatform({ withAtieu: false });
  platform.services.merchants.onboard({ merchantId: "QUANEXP001", name: "Quán Exp", slug: "quan-exp", module: "generic" });

  const result = platform.services.subscriptions.expireIfNeeded("QUANEXP001");
  assert.equal(result.status, "TRIAL");
  assert.equal(platform.repos.merchants.getById("QUANEXP001").account_status, "PENDING"); // onboarding never auto-activates
});

test("expireIfNeeded flips an overdue trial to EXPIRED on both subscription and account, and sets active=false", () => {
  const platform = buildTestPlatform({ withAtieu: false });
  const merchant = platform.services.merchants.onboard({
    merchantId: "QUANEXP002",
    name: "Quán Exp 2",
    slug: "quan-exp-2",
    module: "generic",
  });
  platform.services.merchants.activate(merchant.merchant_id); // -> account_status ACTIVE, active=1

  // Force the trial to already be over.
  const sub = platform.repos.subscriptions.getActiveByMerchant("QUANEXP002");
  platform.db.prepare(`UPDATE merchant_subscriptions SET trial_ends_at = datetime('now', '-1 day') WHERE id = ?`).run(sub.id);

  const result = platform.services.subscriptions.expireIfNeeded("QUANEXP002");
  assert.equal(result.status, "EXPIRED");

  const merchantAfter = platform.repos.merchants.getById("QUANEXP002");
  assert.equal(merchantAfter.account_status, "EXPIRED");
  assert.equal(merchantAfter.active, 0);
  assert.equal(merchantAfter.status, "EXPIRED"); // legacy field stays in sync too

  assert.equal(platform.services.merchantData.listDiscoverable().some((m) => m.merchant_id === "QUANEXP002"), false);
});

test("renew() reactivates an expired merchant on both subscription and account", () => {
  const platform = buildTestPlatform({ withAtieu: false });
  const merchant = platform.services.merchants.onboard({
    merchantId: "QUANEXP003",
    name: "Quán Exp 3",
    slug: "quan-exp-3",
    module: "generic",
  });
  platform.services.merchants.activate(merchant.merchant_id);
  const sub = platform.repos.subscriptions.getActiveByMerchant("QUANEXP003");
  platform.db.prepare(`UPDATE merchant_subscriptions SET trial_ends_at = datetime('now', '-1 day') WHERE id = ?`).run(sub.id);
  platform.services.subscriptions.expireIfNeeded("QUANEXP003");

  const future = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
  const renewed = platform.services.subscriptions.renew("QUANEXP003", future);
  assert.equal(renewed.status, "ACTIVE");
  assert.equal(renewed.expires_at, future);

  const merchantAfter = platform.repos.merchants.getById("QUANEXP003");
  assert.equal(merchantAfter.account_status, "ACTIVE");
  assert.equal(merchantAfter.active, 1);
  assert.equal(platform.services.merchantData.listDiscoverable().some((m) => m.merchant_id === "QUANEXP003"), true);
});
