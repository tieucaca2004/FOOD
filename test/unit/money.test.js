import { test } from "node:test";
import assert from "node:assert/strict";
import { formatVnd, isValidQuantity, sumLineTotals } from "../../src/domain/money.js";

test("formatVnd formats VND with thousands separators", () => {
  assert.equal(formatVnd(65000), "65.000đ");
  assert.equal(formatVnd(205000), "205.000đ");
});

test("isValidQuantity rejects zero, negative, non-integer, and over-limit", () => {
  assert.equal(isValidQuantity(2, 50), true);
  assert.equal(isValidQuantity(0, 50), false);
  assert.equal(isValidQuantity(-5, 50), false);
  assert.equal(isValidQuantity(1.5, 50), false);
  assert.equal(isValidQuantity(999999, 50), false);
});

test("sumLineTotals computes totals in code, not from any client input", () => {
  const items = [
    { unit_price: 65000, quantity: 2 },
    { unit_price: 75000, quantity: 1 },
  ];
  assert.equal(sumLineTotals(items), 205000);
});
