import { test } from "node:test";
import assert from "node:assert/strict";
import { rankMerchantResults } from "../../domain/ranking.js";

function candidate({ name, sponsored = false, matchQuality = "keyword", available = true, status = "ACTIVE" }) {
  return { merchant: { merchant_id: name, name, sponsored }, matchQuality, hasAvailableMatch: available, merchantStatus: status };
}

test("sponsored results are always kept in a separate bucket from organic — never disguised", () => {
  const { organic, sponsored } = rankMerchantResults([
    candidate({ name: "A", sponsored: false }),
    candidate({ name: "B", sponsored: true }),
  ]);
  assert.equal(organic.length, 1);
  assert.equal(sponsored.length, 1);
  assert.equal(organic[0].merchant.name, "A");
  assert.equal(sponsored[0].merchant.name, "B");
});

test("exact match outranks keyword match, which outranks category match", () => {
  const { organic } = rankMerchantResults([
    candidate({ name: "Category", matchQuality: "category" }),
    candidate({ name: "Exact", matchQuality: "exact" }),
    candidate({ name: "Keyword", matchQuality: "keyword" }),
  ]);
  assert.deepEqual(organic.map((c) => c.merchant.name), ["Exact", "Keyword", "Category"]);
});

test("ACTIVE outranks TRIAL at equal match quality", () => {
  const { organic } = rankMerchantResults([
    candidate({ name: "Trial", status: "TRIAL" }),
    candidate({ name: "Active", status: "ACTIVE" }),
  ]);
  assert.deepEqual(organic.map((c) => c.merchant.name), ["Active", "Trial"]);
});
