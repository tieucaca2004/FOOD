import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTestPlatform } from "../helpers/testPlatform.js";

function setup() {
  const platform = buildTestPlatform({ withAtieu: false, genericFixtureMerchants: ["MERCHANT002", "MERCHANT003"] });
  platform.repos.merchants.create({ merchantId: "PCT001", name: "Quán 100% Ngon", slug: "quan-100-ngon", module: "generic", status: "ACTIVE" });
  platform.repos.merchants.create({ merchantId: "UND001", name: "Quán A_B", slug: "quan-a-b", module: "generic", status: "ACTIVE" });
  platform.repos.merchants.create({ merchantId: "BSL001", name: "Quán C\\D", slug: "quan-c-d", module: "generic", status: "ACTIVE" });
  const names = (text) => platform.repos.merchants.findByNameFragment(text).map((m) => m.name).sort();
  return { platform, names };
}

test("EDGE-002: a literal % only matches names containing %", () => {
  const { names } = setup();
  assert.deepEqual(names("%"), ["Quán 100% Ngon"]);
  assert.deepEqual(names("100%"), ["Quán 100% Ngon"]);
});

test("EDGE-002: a literal _ only matches names containing _", () => {
  const { names } = setup();
  assert.deepEqual(names("_"), ["Quán A_B"]);
  assert.deepEqual(names("M_rchant"), []);
});

test("EDGE-002: a literal backslash is matched as itself", () => {
  const { names } = setup();
  assert.deepEqual(names("C\\D"), ["Quán C\\D"]);
});

test("EDGE-002: normal partial, case-insensitive name search still works", () => {
  const { names } = setup();
  assert.deepEqual(names("Merchant"), ["Merchant 002 (Test Fixture)", "Merchant 003 (Test Fixture)"]);
  assert.deepEqual(names("merchant 002"), ["Merchant 002 (Test Fixture)"]);
  assert.deepEqual(names("  Quán A_B  "), ["Quán A_B"]);
});

test("EDGE-002: discovery's name lookup inherits the literal matching", () => {
  const { platform } = setup();
  assert.deepEqual(platform.discovery.searchByMerchantName("%").map((m) => m.merchant_id), ["PCT001"]);
});

test("name search folds case and diacritics but stays literal, and a blank fragment matches nothing", () => {
  const { names } = setup();
  assert.deepEqual(names("QUÁN 100%"), ["Quán 100% Ngon"]);
  assert.deepEqual(names("quan a_b"), ["Quán A_B"]);
  assert.deepEqual(names("QUAN C\\D"), ["Quán C\\D"]);
  assert.deepEqual(names("quan a%b"), []);
  assert.deepEqual(names("   "), []);
});
