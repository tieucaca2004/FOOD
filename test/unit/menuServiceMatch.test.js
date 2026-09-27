// A Tiểu legacy product matching (src/services/menuService.findProductMatches): whole words, accents typed
// respected, a one-word keyword only when the rest of the message is filler. Evidence: Phase 1.5 — live
// Telegram 2026-09-26 "Có bún bò ko" / "Bún bò huế đó" were answered with Hủ Tiếu Xào Bò.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MenuService } from "../../src/services/menuService.js";

// the A Tiểu products with their real keywords (atieu.db)
const PRODUCTS = [
  { id: 1, name: "Hủ Tiếu Xào Bò", keywords: ["bo", "hu tieu bo", "hu tieu xao bo"], price: 65000, available: 1 },
  { id: 2, name: "Hủ Tiếu Xào Hải Sản", keywords: ["hai san", "haisan", "hu tieu hai san"], price: 75000, available: 1 },
  { id: 3, name: "Hủ Tiếu Xào Thập Cẩm", keywords: ["thap cam", "thapcam", "hu tieu thap cam"], price: 60000, available: 1 },
  { id: 4, name: "Hủ Tiếu Xào Đặc Biệt", keywords: ["dac biet", "dacbiet", "hu tieu dac biet"], price: 85000, available: 1 },
];
const menu = new MenuService({ products: { list: () => PRODUCTS } });
const exact = (text) => menu.findProductMatches(text).exact?.name ?? null;
const any = (text) => {
  const r = menu.findProductMatches(text);
  return [r.exact, ...r.candidates].filter(Boolean).map((p) => p.name);
};

test("LEGACY MATCH: orders and product questions that worked keep working", () => {
  for (const [text, name] of [
    ["Bò", "Hủ Tiếu Xào Bò"],
    ["Cho 1 bò", "Hủ Tiếu Xào Bò"],
    ["Cho 2 hủ tiếu xào bò", "Hủ Tiếu Xào Bò"],
    ["cho tôi 2 hủ tiếu bò", "Hủ Tiếu Xào Bò"],
    ["thêm 1 bò nhé", "Hủ Tiếu Xào Bò"],
    ["Thêm 1 hải sản", "Hủ Tiếu Xào Hải Sản"],
    ["Hải Sản", "Hủ Tiếu Xào Hải Sản"],
    ["hu tieu xao bo", "Hủ Tiếu Xào Bò"],
    ["1 thapcam", "Hủ Tiếu Xào Thập Cẩm"],
    ["bỏ bò", "Hủ Tiếu Xào Bò"],
    ["bò bao nhiêu tiền", "Hủ Tiếu Xào Bò"],
  ]) assert.equal(exact(text), name, text);
});

test("LEGACY MATCH: another dish that shares a word is NOT this product (no substring, no false positive)", () => {
  for (const text of ["Có bún bò ko", "Bún bò huế đó", "bun bo hue", "có bánh bò không", "combo nào rẻ", "khủng bố", "bơ", "bò bía", "phở bò có không"]) {
    assert.deepEqual(any(text), [], text);
  }
});

test("LEGACY MATCH: accents typed are the product's own; accent-free text still matches by words", () => {
  assert.equal(exact("cho 1 bơ"), null); // "bơ" (avocado) is not "bò"
  assert.equal(exact("cho 1 bo"), "Hủ Tiếu Xào Bò"); // typed without accents: the word matches
  assert.equal(exact("dac biet"), "Hủ Tiếu Xào Đặc Biệt");
});
