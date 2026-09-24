import { test } from "node:test";
import assert from "node:assert/strict";
import { parseGenericOrderMessage } from "../../nlp/genericOrderIntent.js";

const PRODUCTS = [
  { id: 1, name: "Hủ Tiếu Xào Hải Sản", keywords: ["hai san", "hu tieu hai san"] },
  { id: 2, name: "Cà Phê Sữa Đá", keywords: ["ca phe sua"] },
  { id: 3, name: "Cà Phê Đá", keywords: [] },
];
const parse = (text) => parseGenericOrderMessage(text, PRODUCTS);

test("cart and order commands", () => {
  for (const t of ["xem menu", "cho tôi xem menu", "thực đơn"]) assert.equal(parse(t).type, "menu", t);
  for (const t of ["xem giỏ hàng", "giỏ hàng"]) assert.equal(parse(t).type, "view_cart", t);
  for (const t of ["xóa giỏ hàng", "hủy giỏ"]) assert.equal(parse(t).type, "clear_cart", t);
  for (const t of ["đặt hàng", "Đặt hàng nha", "chốt đơn", "đặt"]) assert.equal(parse(t).type, "place_order", t);
});

test("adding a dish reads the quantity in digits, number words, before or after the dish", () => {
  const cases = [
    ["cho tôi 2 cà phê sữa đá", 2, 2],
    ["thêm cà phê sữa đá", 2, 1],
    ["cà phê sữa đá 3 ly", 2, 3],
    ["cho tôi 2 ly cà phê sữa đá nha", 2, 2],
    ["thêm hai hủ tiếu xào hải sản", 1, 2],
    ["thêm hải sản", 1, 1],
    ["thêm hủ tiếu xào hải sản", 1, 1],
  ];
  for (const [text, id, quantity] of cases) {
    const r = parse(text);
    assert.equal(r.type, "add", text);
    assert.equal(r.product.id, id, text);
    assert.equal(r.quantity, quantity, text);
  }
});

test("quantities are passed through as typed: limits belong to the cart service", () => {
  assert.equal(parse("cho tôi 0 cà phê sữa đá").quantity, 0);
  assert.equal(parse("cho tôi 999 cà phê sữa đá").quantity, 999);
});

test("ambiguous, deictic, unknown and unrelated messages never pick a dish", () => {
  assert.deepEqual(parse("cho tôi 1 cà phê").products.map((p) => p.id).sort(), [2, 3]);
  assert.equal(parse("thêm 2 món này").type, "which_item");
  for (const t of ["cho tôi 2 phở", "thêm 1 hủ tiếu xá xíu", "cho tôi 2 %' OR 1=1 --", "thêm 1 %", "cho tôi 2 _", "thêm 1 product_id=1"]) {
    assert.equal(parse(t).type, "unknown_item", t);
  }
  for (const t of ["xin chào", "ok", ""]) assert.equal(parse(t).type, "help", t);
});
