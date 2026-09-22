import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTestPlatform } from "../helpers/testPlatform.js";

// Test 1 + 2: global food search, multiple merchants.
test("Test 1/2: global food search returns multiple real merchants for an overlapping keyword", async () => {
  const platform = buildTestPlatform({ genericFixtureMerchants: ["MERCHANT002"] });
  const { organic } = await platform.agentSearch.searchMerchants("hải sản");
  const ids = organic.map((c) => c.merchant.merchant_id).sort();
  assert.deepEqual(ids, ["ATIEU001", "MERCHANT002"]);
});

// Test 3: merchant-context search stays scoped to one merchant.
test("Test 3: merchant-context search ('món bò bao nhiêu?' with merchant_id=ATIEU001) never returns MERCHANT002/003 data", async () => {
  const platform = buildTestPlatform({ genericFixtureMerchants: ["MERCHANT002", "MERCHANT003"] });

  const result = await platform.agentSearch.search("bò", { merchantId: "ATIEU001" });
  assert.equal(result.merchantId, "ATIEU001");
  assert.ok(result.matches.length > 0);
  assert.ok(result.matches.every((m) => m.name.includes("Bò")));

  // MERCHANT003 also sells a "Hủ Tiếu Xào Bò" fixture product — prove its
  // product id never leaks into the ATIEU001-scoped result.
  const merchant003Adapter = platform.registry.getAdapter("MERCHANT003");
  const merchant003Matches = await merchant003Adapter.searchProducts("bò");
  const merchant003Ids = new Set(merchant003Matches.map((m) => m.productId));
  assert.equal(result.matches.some((m) => merchant003Ids.has(m.productId)), false);
});

// Test 4: inactive merchant excluded (active=false via setAccountStatus).
test("Test 4: merchant with active=false is excluded from search even if account_status looks otherwise valid", async () => {
  const platform = buildTestPlatform({ genericFixtureMerchants: ["MERCHANT002"] });
  platform.repos.merchants.setAccountStatus("MERCHANT002", "ACTIVE", false);

  const { organic } = await platform.agentSearch.searchMerchants("hải sản");
  assert.equal(organic.some((c) => c.merchant.merchant_id === "MERCHANT002"), false);
});

// Test 5: expired merchant excluded.
test("Test 5: EXPIRED merchant is excluded from global search", async () => {
  const platform = buildTestPlatform({ genericFixtureMerchants: ["MERCHANT002"] });
  platform.repos.merchants.setStatus("MERCHANT002", "EXPIRED");

  const { organic } = await platform.agentSearch.searchMerchants("hải sản");
  assert.equal(organic.some((c) => c.merchant.merchant_id === "MERCHANT002"), false);
});

// Test 6: suspended (TEMPORARY_SUSPENDED) merchant excluded.
test("Test 6: TEMPORARY_SUSPENDED merchant is excluded from global search", async () => {
  const platform = buildTestPlatform({ genericFixtureMerchants: ["MERCHANT002"] });
  platform.repos.merchants.setStatus("MERCHANT002", "SUSPENDED"); // -> account_status TEMPORARY_SUSPENDED

  const { organic } = await platform.agentSearch.searchMerchants("hải sản");
  assert.equal(organic.some((c) => c.merchant.merchant_id === "MERCHANT002"), false);
  assert.equal(platform.repos.merchants.getById("MERCHANT002").account_status, "TEMPORARY_SUSPENDED");
});

// Test 7: A Tiểu remains discoverable purely as a Merchant Record — no
// "if merchant === A Tiểu" special-casing anywhere in this path.
test("Test 7: A Tiểu is discoverable through the exact same generic path as MERCHANT002/003", async () => {
  const platform = buildTestPlatform({ genericFixtureMerchants: ["MERCHANT002", "MERCHANT003"] });
  const { organic } = await platform.agentSearch.searchMerchants("hủ tiếu xào bò");
  const ids = organic.map((c) => c.merchant.merchant_id);
  assert.ok(ids.includes("ATIEU001"));
  assert.ok(ids.includes("MERCHANT003")); // also sells "Hủ Tiếu Xào Bò"
});

// Test 8: legacy behavior (DiscoveryEngine.searchByKeywords/searchByMerchantName
// called directly, bypassing AgentSearchService) still works identically —
// proves the Phase 2 cutover changed only the access path, not behavior.
test("Test 8: legacy DiscoveryEngine direct calls still behave exactly as before Phase 2", async () => {
  const platform = buildTestPlatform();
  const byName = platform.discovery.searchByMerchantName("A Tiểu");
  assert.equal(byName.length, 1);
  assert.equal(byName[0].merchant_id, "ATIEU001");

  const { organic } = await platform.discovery.searchByKeywords("hủ tiếu xào bò");
  assert.equal(organic.length, 1);
  assert.equal(organic[0].merchant.merchant_id, "ATIEU001");
});
