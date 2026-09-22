import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMenuText, flagDuplicates } from "../../services/menuParserService.js";

// 1. Valid text import
test("1. valid text import parses name + price", () => {
  const draft = parseMenuText("Hủ Tiếu Xào Bò 65k");
  assert.equal(draft.categories.length, 1);
  assert.equal(draft.categories[0].products.length, 1);
  const p = draft.categories[0].products[0];
  assert.equal(p.name, "Hủ Tiếu Xào Bò");
  assert.equal(p.price, 65000);
  assert.equal(p.needs_review, false);
});

// 2. Multiple categories
test("2. multiple categories via explicit ':' header lines", () => {
  const text = ["Hủ Tiếu Xào:", "Hủ Tiếu Xào Bò 65k", "Nước Uống:", "Trà Đá 5k"].join("\n");
  const draft = parseMenuText(text);
  assert.equal(draft.categories.length, 2);
  assert.equal(draft.categories[0].name, "Hủ Tiếu Xào");
  assert.equal(draft.categories[1].name, "Nước Uống");
});

// 3. Multiple products
test("3. multiple products under one category", () => {
  const text = ["Hủ Tiếu Xào Bò 65k", "Hủ Tiếu Xào Hải Sản 75k", "Mì Xào Giòn Bò 75k"].join("\n");
  const draft = parseMenuText(text);
  assert.equal(draft.categories.length, 1);
  assert.equal(draft.categories[0].products.length, 3);
  assert.deepEqual(
    draft.categories[0].products.map((p) => p.price),
    [65000, 75000, 75000]
  );
});

// 4. Price parsing formats
test("4. price parsing handles 65000 / 65.000 / 65,000 / 65k", () => {
  for (const [line, expected] of [
    ["Món A 65000", 65000],
    ["Món B 65.000", 65000],
    ["Món C 65,000", 65000],
    ["Món D 65k", 65000],
    ["Món E 65K", 65000],
  ]) {
    const draft = parseMenuText(line);
    assert.equal(draft.categories[0].products[0].price, expected, line);
  }
});

// 5. Missing price
test("5. missing price -> price null, needs_review true, no guessing", () => {
  const draft = parseMenuText("Mì bò đặc biệt");
  const p = draft.categories[0].products[0];
  assert.equal(p.name, "Mì bò đặc biệt");
  assert.equal(p.price, null);
  assert.equal(p.needs_review, true);
});

// 6. Invalid/ambiguous price text — never guessed
test("6. ambiguous price tokens never get silently resolved", () => {
  for (const line of ["Món lạ 65?000", "Món khác 6?000", "Món mù mờ giá không rõ"]) {
    const draft = parseMenuText(line);
    const p = draft.categories[0].products[0];
    assert.equal(p.price, null, line);
    assert.equal(p.needs_review, true, line);
  }
});

// 7. Duplicate detection
test("7. duplicate product names within a category are flagged, not removed", () => {
  const text = ["Hủ Tiếu Xào Bò 65k", "Hủ Tiếu Xào Bò 65k"].join("\n");
  const draft = flagDuplicates(parseMenuText(text));
  assert.equal(draft.categories[0].products.length, 2); // never auto-removed
  assert.equal(draft.categories[0].products[0].possible_duplicate, false);
  assert.equal(draft.categories[0].products[1].possible_duplicate, true);
});

test("empty text produces an empty draft, not an error", () => {
  const draft = parseMenuText("");
  assert.deepEqual(draft.categories, []);
});
