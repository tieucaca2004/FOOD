import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeSearchQuery, normalizeForMatch, matchesMerchantName } from "../../nlp/searchQuery.js";
import { rankMerchantResults } from "../../domain/ranking.js";

const kw = (text) => normalizeSearchQuery(text).text;

test("normalizeForMatch: lowercase, accents stripped, punctuation collapsed", () => {
  assert.equal(normalizeForMatch("  [DEMO] Nôm Nôm-Restaurant! "), "demo nom nom restaurant");
  assert.equal(normalizeForMatch("Hủ Tiếu Xào A Tiểu"), "hu tieu xao a tieu");
  assert.equal(normalizeForMatch("Đậu hũ"), "dau hu");
});

test("leading search phrases are stripped, accented or not", () => {
  assert.equal(kw("Tìm Nôm Nôm"), "Nôm Nôm");
  assert.equal(kw("tim nom nom"), "nom nom");
  assert.equal(kw("Tìm quán Nôm Nôm"), "Nôm Nôm");
  assert.equal(kw("tim quán nomnom"), "nomnom"); // real Telegram message that used to fail
  assert.equal(kw("Tìm nhà hàng Nôm Nôm"), "Nôm Nôm");
  assert.equal(kw("Cho tôi tìm Nôm Nôm"), "Nôm Nôm");
  assert.equal(kw("Tìm giúp tôi quán Nôm Nôm"), "Nôm Nôm");
  assert.equal(kw("Tìm kiếm pizza"), "pizza");
  assert.equal(kw("Tôi muốn ăn hủ tiếu xào."), "hủ tiếu xào");
});

test("trailing politeness is stripped; words in the middle are kept exactly as typed", () => {
  assert.equal(kw("Tìm pizza nha"), "pizza");
  assert.equal(kw("cho mình hủ tiếu xào bò không ạ?"), "hủ tiếu xào bò");
  assert.equal(kw("Tìm Seafood Pizza - Pizza Hải Sản 28cm"), "Seafood Pizza - Pizza Hải Sản 28cm");
  assert.deepEqual(normalizeSearchQuery("Tìm hủ tiếu xào"), { text: "hủ tiếu xào", normalized: "hu tieu xao" });
});

test("a query is never stripped down to nothing, and empty input stays empty", () => {
  assert.equal(kw("Tìm"), "Tìm");
  assert.equal(kw("Tìm quán"), "quán");
  assert.deepEqual(normalizeSearchQuery(""), { text: "", normalized: "" });
  assert.deepEqual(normalizeSearchQuery("   "), { text: "", normalized: "" });
});

test("matchesMerchantName: name or slug, accent-insensitive, whole words or 5+ char compact", () => {
  const demo = { name: "[DEMO] Nôm Nôm Restaurant", slug: "demo-nom-nom-restaurant" };
  const atieu = { name: "Hủ Tiếu Xào A Tiểu", slug: "hu-tieu-xao-a-tieu" };
  const q = (text) => normalizeSearchQuery(text).normalized;

  for (const text of ["Nôm Nôm", "nom nom", "Nôm Nôm Restaurant", "nom nom restaurant", "restaurant nom nom", "nomnom", "demo-nom-nom-restaurant"]) {
    assert.equal(matchesMerchantName(demo, q(text)), true, text);
    assert.equal(matchesMerchantName(atieu, q(text)), false, `A Tiểu must not match "${text}"`);
  }
  assert.equal(matchesMerchantName(atieu, q("A Tiểu")), true);
  assert.equal(matchesMerchantName(atieu, q("hu tieu xao")), true);
  assert.equal(matchesMerchantName(demo, q("hủ tiếu xào")), false);
  assert.equal(matchesMerchantName(demo, q("pizza")), false);
  assert.equal(matchesMerchantName(demo, q("xyzxyz")), false);
  assert.equal(matchesMerchantName(demo, q("no")), false); // too short to mean anything
  assert.equal(matchesMerchantName(demo, q("omno")), false); // compact match needs 5+ chars
});

test("ranking: a merchant-name match outranks the best possible product-only match", () => {
  const byProduct = { merchant: { merchant_id: "P", sponsored: 0 }, matchQuality: "exact", hasAvailableMatch: true, merchantStatus: "ACTIVE" };
  const byName = { merchant: { merchant_id: "N", sponsored: 0 }, matchQuality: "merchant_name", merchantNameMatch: true, hasAvailableMatch: false, merchantStatus: "ACTIVE" };
  const { organic } = rankMerchantResults([byProduct, byName]);
  assert.deepEqual(organic.map((c) => c.merchant.merchant_id), ["N", "P"]);
});

test("ranking: sponsored name matches stay in the sponsored list", () => {
  const sponsoredByName = { merchant: { merchant_id: "S", sponsored: 1 }, matchQuality: "merchant_name", merchantNameMatch: true, merchantStatus: "ACTIVE" };
  const { organic, sponsored } = rankMerchantResults([sponsoredByName]);
  assert.equal(organic.length, 0);
  assert.equal(sponsored[0].merchant.merchant_id, "S");
});
