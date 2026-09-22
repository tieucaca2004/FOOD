import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyIntent } from "../../src/nlp/intentEngine.js";
import { extractQuantity } from "../../src/nlp/normalize.js";

const cases = [
  ["Xin chào", "greeting"],
  ["Cho tôi xem menu", "show_menu"],
  ["Hủ tiếu bò bao nhiêu", "product_price"],
  ["Cho anh 2 bò", "add_to_cart"],
  ["Thêm một hải sản", "add_to_cart"],
  ["Bỏ món bò", "remove_from_cart"],
  ["Đổi bò thành 3 phần", "update_cart"],
  ["Cho tôi xem giỏ", "show_cart"],
  ["Đặt luôn", "checkout"],
  ["Ok chốt", "confirm_order"],
  ["Thôi không đặt nữa", "cancel_order"],
];

for (const [text, expected] of cases) {
  test(`classifyIntent("${text}") -> ${expected}`, () => {
    assert.equal(classifyIntent(text).intent, expected);
  });
}

test("unknown gibberish falls back to unknown, never guesses", () => {
  assert.equal(classifyIntent("asdkjaskdj random text").intent, "unknown");
});

test("extractQuantity reads digits and Vietnamese number words", () => {
  assert.equal(extractQuantity("Cho anh 2 bò"), 2);
  assert.equal(extractQuantity("Thêm một hải sản"), 1);
  assert.equal(extractQuantity("Không có số nào ở đây"), null);
});
