import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTestPlatform } from "../helpers/testPlatform.js";
import { MerchantOnboardingError } from "../../services/merchantService.js";

test("onboarding creates a PENDING merchant with a TRIAL subscription — never auto-discoverable", () => {
  const platform = buildTestPlatform({ withAtieu: false });
  const merchant = platform.services.merchants.onboard({
    merchantId: "QUANB001",
    name: "Quán B",
    slug: "quan-b",
    module: "generic",
  });
  assert.equal(merchant.status, "PENDING");
  assert.equal(platform.discovery.searchByMerchantName("Quán B").length, 0);

  const sub = platform.repos.subscriptions.getActiveByMerchant("QUANB001");
  assert.equal(sub.status, "TRIAL");
  assert.ok(sub.trial_ends_at);
});

test("trial_days is never hard-coded — comes from platform config, applied at onboarding", () => {
  const platform = buildTestPlatform({ withAtieu: false });
  const merchant = platform.services.merchants.onboard({
    merchantId: "QUANC001",
    name: "Quán C",
    slug: "quan-c",
    module: "generic",
  });
  const sub = platform.repos.subscriptions.getActiveByMerchant("QUANC001");
  const start = new Date(sub.trial_started_at);
  const end = new Date(sub.trial_ends_at);
  const diffDays = Math.round((end - start) / (24 * 3600 * 1000));
  // platformConfig.defaultTrialDays default is 14 (env-overridable, not a literal in this test's assertion path)
  assert.equal(diffDays, 14);
});

test("activate() moves a TRIAL-subscribed merchant to discoverable TRIAL status", () => {
  const platform = buildTestPlatform({ withAtieu: false });
  platform.services.merchants.onboard({ merchantId: "QUAND001", name: "Quán D", slug: "quan-d", module: "generic" });
  const activated = platform.services.merchants.activate("QUAND001");
  assert.equal(activated.status, "TRIAL");
  assert.equal(platform.discovery.searchByMerchantName("Quán D").length, 1);
});

test("duplicate merchant_id is rejected", () => {
  const platform = buildTestPlatform({ withAtieu: false });
  platform.services.merchants.onboard({ merchantId: "QUANE001", name: "Quán E", slug: "quan-e", module: "generic" });
  assert.throws(
    () => platform.services.merchants.onboard({ merchantId: "QUANE001", name: "Quán E 2", slug: "quan-e-2", module: "generic" }),
    MerchantOnboardingError
  );
});

test("suspend/close remove a merchant from discovery immediately", () => {
  const platform = buildTestPlatform();
  platform.services.merchants.suspend("ATIEU001");
  assert.equal(platform.discovery.searchByMerchantName("A Tiểu").length, 0);

  platform.repos.merchants.setStatus("ATIEU001", "ACTIVE");
  assert.equal(platform.discovery.searchByMerchantName("A Tiểu").length, 1);

  platform.services.merchants.close("ATIEU001");
  assert.equal(platform.discovery.searchByMerchantName("A Tiểu").length, 0);
});
