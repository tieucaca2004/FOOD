import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyConciergeIntent } from "../../nlp/concierge.js";

test("greeting", () => {
  assert.equal(classifyConciergeIntent("Xin chào").intent, "greeting");
});

test("the chat-app /start command is a greeting, with or without a bot mention or payload", () => {
  for (const text of ["/start", "/start@ChefBotAI_bot", "/START", "/start ref123"]) {
    assert.equal(classifyConciergeIntent(text).intent, "greeting", text);
  }
});

test("text that merely resembles /start is not treated as the command", () => {
  const r = classifyConciergeIntent("/started hủ tiếu");
  assert.notEqual(r.intent, "greeting");
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
