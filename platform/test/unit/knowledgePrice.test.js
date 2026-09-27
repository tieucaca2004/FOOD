// Price text -> integer VND: only what is unambiguously written.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePrice } from "../../knowledge/price.js";
import { isStale, FRESHNESS_DAYS } from "../../knowledge/freshness.js";

test("PRICE: common Vietnamese formats", () => {
  const p = (t) => parsePrice(t).price;
  assert.equal(p("45K"), 45000);
  assert.equal(p("45k"), 45000);
  assert.equal(p("45.000đ"), 45000);
  assert.equal(p("45,000 VND"), 45000);
  assert.equal(p("45.000 đồng"), 45000);
  assert.equal(p("45 nghìn"), 45000);
  assert.equal(p("45 ngàn"), 45000);
  assert.equal(p("75000"), 75000);
  assert.equal(p("1tr2"), 1200000);
  assert.equal(p("1,2 triệu"), 1200000);
  assert.equal(p("35.5k"), 35500);
  assert.equal(p("50.000đ/tô"), 50000);
  // the đồng sign as merchant menus write it
  assert.equal(p("110,000 ₫"), 110000);
  assert.equal(p("45,000₫"), 45000);
  assert.equal(p("120.000 ₫"), 120000);
});

test("PRICE: ranges keep both ends", () => {
  assert.deepEqual(parsePrice("45-60k"), { price: 45000, priceMax: 60000, currency: "VND" });
  assert.deepEqual(parsePrice("45k - 60k"), { price: 45000, priceMax: 60000, currency: "VND" });
  assert.deepEqual(parsePrice("30.000đ – 50.000đ"), { price: 30000, priceMax: 50000, currency: "VND" });
});

test("PRICE: anything unclear is null, never guessed", () => {
  for (const t of ["giá liên hệ", "thời giá", "", "45", "rẻ", "60-45k", "1-2-3k", "45 tô"]) assert.equal(parsePrice(t).price, null, t);
});

test("FRESHNESS: observations age out by kind", () => {
  const now = new Date("2026-09-25T00:00:00Z");
  assert.equal(isStale("price", "2026-09-01", now), false);
  assert.equal(isStale("price", "2026-01-01", now), true);
  assert.equal(isStale("rating", "2026-05-01", now), true); // ratings age faster
  assert.equal(isStale("unknown-kind", "2026-09-24", now), true);
  assert.ok(FRESHNESS_DAYS.price >= 90);
});
