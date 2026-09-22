import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentSearchService } from "../../services/agentSearchService.js";

function fakeAdapter(matches) {
  return { searchProducts: async () => matches };
}

test("search() with no merchantId delegates to searchMerchants (global)", async () => {
  let calledWith = null;
  const discovery = { searchByKeywords: async (q) => { calledWith = q; return { organic: [], sponsored: [] }; } };
  const svc = new AgentSearchService({ discovery, registry: {} });

  const result = await svc.search("hủ tiếu xào");
  assert.equal(calledWith, "hủ tiếu xào");
  assert.deepEqual(result, { organic: [], sponsored: [] });
});

test("search() with a merchantId delegates to searchWithinMerchant, never to global discovery", async () => {
  let globalCalled = false;
  const discovery = { searchByKeywords: async () => { globalCalled = true; return { organic: [], sponsored: [] }; } };
  const registry = { getAdapter: () => fakeAdapter([{ productId: 1, name: "Hủ Tiếu Xào Bò", price: 65000, available: true }]) };
  const svc = new AgentSearchService({ discovery, registry });

  const result = await svc.search("bò", { merchantId: "ATIEU001" });
  assert.equal(globalCalled, false); // tenant isolation: never touches global discovery
  assert.equal(result.merchantId, "ATIEU001");
  assert.equal(result.matches.length, 1);
});

test("searchWithinMerchant returns empty matches (not an error) for an unregistered merchant", async () => {
  const registry = { getAdapter: () => null };
  const svc = new AgentSearchService({ discovery: {}, registry });
  const result = await svc.searchWithinMerchant("NOPE001", "bò");
  assert.deepEqual(result, { merchantId: "NOPE001", matches: [] });
});

test("searchProducts (global) flattens organic+sponsored candidates into the §19 result contract", async () => {
  const discovery = {
    searchByKeywords: async () => ({
      organic: [
        {
          merchant: { merchant_id: "ATIEU001", name: "Hủ Tiếu Xào A Tiểu" },
          matches: [{ productId: 1, name: "Hủ Tiếu Xào Bò", price: 65000, available: true }],
        },
      ],
      sponsored: [],
    }),
  };
  const svc = new AgentSearchService({ discovery, registry: {} });
  const rows = await svc.searchProducts("bò");
  assert.deepEqual(rows, [
    { merchant_id: "ATIEU001", merchant_name: "Hủ Tiếu Xào A Tiểu", product_id: 1, product_name: "Hủ Tiếu Xào Bò", price: 65000, availability: true },
  ]);
});

test("searchProducts scoped to a merchantId never invents a price/availability — passes through the adapter's own data untouched", async () => {
  const registry = {
    getAdapter: () => fakeAdapter([{ productId: 7, name: "Hủ Tiếu Xào Hải Sản", price: 75000, available: false }]),
    repos: { merchants: { getById: () => ({ name: "Hủ Tiếu Xào A Tiểu" }) } },
  };
  const svc = new AgentSearchService({ discovery: {}, registry });
  const rows = await svc.searchProducts("hải sản", { merchantId: "ATIEU001" });
  assert.deepEqual(rows, [
    { merchant_id: "ATIEU001", merchant_name: "Hủ Tiếu Xào A Tiểu", product_id: 7, product_name: "Hủ Tiếu Xào Hải Sản", price: 75000, availability: false },
  ]);
});
