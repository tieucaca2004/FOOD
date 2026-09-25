import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyMerchantFollowUp, parseProductQuestion } from "../../nlp/merchantFollowUp.js";

const kind = (text) => classifyMerchantFollowUp(text)?.kind ?? null;

test("menu follow-ups, accented and not", () => {
  for (const text of [
    "có thực đơn ko gửi tui",
    "có menu quán ko",
    "có menu không",
    "xem menu",
    "cho tôi xem thực đơn",
    "menu đâu",
    "quán này có món gì",
    "co thuc don ko",
  ]) {
    assert.equal(kind(text), "menu", text);
  }
});

test("location follow-ups", () => {
  for (const text of ["quán ở đâu", "quan o dau", "địa chỉ quán", "quán này nằm ở đâu", "ở đâu vậy"]) {
    assert.equal(kind(text), "location", text);
  }
});

test("product questions and cart/order intents are merchant-scoped", () => {
  for (const text of ["có Seafood Pizza không", "còn coca ko", "cho tôi 2 Seafood Pizza", "Seafood Pizza bao nhiêu", "xem giỏ", "đặt hàng", "thêm 1 coca"]) {
    assert.equal(kind(text), "merchant_message", text);
  }
  assert.equal(parseProductQuestion("có Seafood Pizza không"), "seafood pizza");
  assert.equal(parseProductQuestion("Quán có gỏi cuốn ko?"), "goi cuon");
  assert.equal(parseProductQuestion("tìm pizza"), null);
});

test("marketplace searches and chit-chat are NOT follow-ups", () => {
  for (const text of ["Tìm pizza", "tìm quán nom nom", "hủ tiếu xào", "Xin chào", "có quán nào bán pizza không", "nhà hàng nào có menu chay", "Tìm xyzxyz"]) {
    assert.equal(classifyMerchantFollowUp(text), null, text);
  }
});

test("the leftover words keep a merchant name mentioned alongside the follow-up", () => {
  assert.equal(classifyMerchantFollowUp("xem menu nom nom").rest, "nom nom");
  assert.equal(classifyMerchantFollowUp("có menu quán ko").rest, "");
});
