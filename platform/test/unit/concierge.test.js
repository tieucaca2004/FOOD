import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyConciergeIntent } from "../../nlp/concierge.js";

test("greeting", () => {
  assert.equal(classifyConciergeIntent("Xin chào").intent, "greeting");
});

test("generic food/category search reduces filler words to keywords", () => {
  const r = classifyConciergeIntent("Tôi muốn ăn hủ tiếu xào.");
  assert.equal(r.intent, "search_food");
  assert.equal(r.searchKeywords, "hủ tiếu xào");
});

test("specific product search keeps the full phrase", () => {
  const r = classifyConciergeIntent("Tôi muốn ăn hủ tiếu xào bò.");
  assert.equal(r.intent, "search_food");
  assert.equal(r.searchKeywords, "hủ tiếu xào bò");
});

test("merchant name hint extraction for 'ăn ở <name>'", () => {
  const r = classifyConciergeIntent("Tôi muốn ăn ở A Tiểu.");
  assert.equal(r.intent, "open_merchant_by_name");
  assert.equal(r.merchantNameHint, "A Tiểu");
});

test("'Xem <name>' is treated as open_merchant_by_name", () => {
  const r = classifyConciergeIntent("Xem A Tiểu");
  assert.equal(r.intent, "open_merchant_by_name");
  assert.equal(r.merchantNameHint, "A Tiểu");
});

test("return to platform triggers", () => {
  for (const text of ["Quay lại tổng đài", "Tìm quán khác", "Đổi quán"]) {
    assert.equal(classifyConciergeIntent(text).intent, "return_to_platform", text);
  }
});

test("global search trigger while presumably inside a merchant", () => {
  assert.equal(classifyConciergeIntent("Có quán nào khác bán món này không?").intent, "global_search");
});

test("empty text is unknown, never guessed", () => {
  assert.equal(classifyConciergeIntent("").intent, "unknown");
});

// Routing contract (live Telegram #277/#279, 2026-09-26): `discovery` separates "find me something" from
// text that is search_food only because nothing else matched. The router sends discovery out of a merchant.
test("discovery: requests to FIND a place or dish, accented or not", () => {
  for (const t of [
    "tìm quán bún cá ở Nha Trang", "tìm Bún Cá Mịn", "Tìm Bún Cá Mịn", "tìm quán bánh căn ở Nha Trang", "tìm hải sản ở Nha Trang",
    "tìm bánh căn", "tìm bún cá", "muốn ăn bún cá ở Nha Trang", "kiếm quán bún cá", "tìm nhà hàng hải sản ở Nha Trang",
    "tim quan bun ca o Nha Trang", "Cho tôi tìm quán phở", "giúp mình kiếm tiệm bánh mì",
  ]) assert.equal(classifyConciergeIntent(t).discovery, true, t);
});

test("discovery: merchant-scoped messages are NOT discovery (they stay with the open merchant)", () => {
  for (const t of [
    "có bún cá không", "có món bún cá không", "menu", "xem menu", "cho tôi 2 pizza", "giá món này", "thêm món này", "xóa món này",
    "đặt món", "giao tới 7 Nguyễn Thiện Thuật", "muốn ăn pizza tại quán", "muốn ăn ở đây", "tim heo nuong", "cho tôi 1 tim heo",
    "Tôi muốn ăn hủ tiếu xào.",
  ]) assert.equal(classifyConciergeIntent(t).discovery, false, t);
  // the existing intents are unchanged by the flag
  assert.equal(classifyConciergeIntent("tìm Bún Cá Mịn").intent, "search_food");
  assert.equal(classifyConciergeIntent("menu").intent, "search_food");
});
