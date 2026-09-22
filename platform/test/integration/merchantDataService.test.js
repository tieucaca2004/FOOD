import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTestPlatform } from "../helpers/testPlatform.js";

test("listDiscoverable reflects account_status/active, not the legacy status string", () => {
  const platform = buildTestPlatform();
  const before = platform.services.merchantData.listDiscoverable();
  assert.equal(before.length, 1);
  assert.equal(before[0].merchant_id, "ATIEU001");
  assert.equal(before[0].account_status, "ACTIVE");
  assert.equal(before[0].active, 1);
});

test("setStatus('SUSPENDED') via the legacy write path is reflected in the new split fields", () => {
  const platform = buildTestPlatform();
  platform.repos.merchants.setStatus("ATIEU001", "SUSPENDED");

  const merchant = platform.services.merchantData.getById("ATIEU001");
  assert.equal(merchant.status, "SUSPENDED"); // legacy field still correct (backward compat)
  assert.equal(merchant.account_status, "TEMPORARY_SUSPENDED"); // new field derived correctly
  assert.equal(merchant.active, 0);
  assert.equal(platform.services.merchantData.listDiscoverable().length, 0);
});

test("setAccountStatus (new write path) does not require the legacy enum", () => {
  const platform = buildTestPlatform();
  platform.repos.merchants.setAccountStatus("ATIEU001", "CLOSED", false);

  const merchant = platform.services.merchantData.getById("ATIEU001");
  assert.equal(merchant.account_status, "CLOSED");
  assert.equal(merchant.active, 0);
  assert.equal(platform.services.merchantData.isDiscoverable(merchant), false);
});

test("findAnyStatusByNameFragment finds a merchant regardless of discoverability, findDiscoverableByNameFragment does not", () => {
  const platform = buildTestPlatform();
  platform.repos.merchants.setStatus("ATIEU001", "SUSPENDED");

  assert.equal(platform.services.merchantData.findAnyStatusByNameFragment("A Tiểu").length, 1);
  assert.equal(platform.services.merchantData.findDiscoverableByNameFragment("A Tiểu").length, 0);
});

test("newly onboarded merchant (PENDING) is never discoverable through MerchantDataService", () => {
  const platform = buildTestPlatform({ withAtieu: false });
  platform.services.merchants.onboard({ merchantId: "QUANZ001", name: "Quán Z", slug: "quan-z", module: "generic" });
  assert.equal(platform.services.merchantData.listDiscoverable().length, 0);

  platform.services.merchants.activate("QUANZ001");
  assert.equal(platform.services.merchantData.listDiscoverable().length, 1);
});
