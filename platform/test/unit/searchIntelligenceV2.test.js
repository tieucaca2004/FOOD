// SEARCH INTELLIGENCE V2 — pure layers: normalization, intent, price filter, word classes, place resolution,
// and the SearchResult contract (planner over a SYNTHETIC fixture, read-only).
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeInput, detectIntent, parsePriceFilter, describePriceFilter, APPROX_TOLERANCE, MerchantIndex } from "../../search/v2/index.js";
import { wordClass } from "../../search/v2/lexicon.js";
import { searchV2Knowledge } from "../helpers/searchV2Knowledge.js";
import { createFoodKnowledge } from "../../services/foodKnowledgeAdapter.js";

test("NORMALIZE: the original is kept; folded is a key only; offsets point into the normalized text", () => {
  const n = normalizeInput("  Bún  Cá??  Nha Trang ");
  assert.equal(n.originalQuery, "  Bún  Cá??  Nha Trang ");
  assert.equal(n.normalizedQuery, "Bún Cá? Nha Trang");
  assert.equal(n.foldedQuery, "bun ca nha trang");
  assert.deepEqual(n.tokens.map((t) => [t.original, t.accented]), [["Bún", true], ["Cá", true], ["Nha", false], ["Trang", false]]);
  assert.equal(n.normalizedQuery.slice(n.tokens[1].start, n.tokens[1].end), "Cá");
  assert.equal(normalizeInput("Đà").tokens[0].folded, "da");
});

test("PRICE FILTER: every natural form, explicit semantics, never a bare quantity", () => {
  const f = (t) => {
    const p = parsePriceFilter(t);
    return p && [p.kind, p.min, p.max];
  };
  assert.equal(APPROX_TOLERANCE, 0.2);
  for (const t of ["khoảng 50k", "tầm 50k", "cỡ 50k", "chừng 50k", "quanh 50k", "khoang 50k", "tam 50 nghìn", "~50k"]) assert.deepEqual(f(t), ["approx", 40000, 60000], t);
  for (const t of ["dưới 50k", "không quá 50k", "tối đa 50.000đ", "ít hơn 50k", "duoi 50k", "<=50k"]) assert.deepEqual(f(t), ["max", null, 50000], t);
  for (const t of ["trên 50k", "hơn 50k", "từ 50k trở lên", "tren 50000"]) assert.deepEqual(f(t), ["min", 50000, null], t);
  for (const t of ["30k đến 50k", "từ 30k đến 50k", "30-50k", "30 - 50k", "30.000 đến 50.000", "30,000-50,000", "30 tới 50k"]) assert.deepEqual(f(t), ["range", 30000, 50000], t);
  assert.deepEqual(f("1tr đến 2tr"), ["range", 1000000, 2000000]);
  for (const t of ["cho 2 tô", "bánh căn 51 Tô Hiến Thành", "bún cá", "Mì Quảng Nam 127", "2 phần"]) assert.equal(parsePriceFilter(t), null, t);
  assert.equal(describePriceFilter(parsePriceFilter("khoảng 50k")), "khoảng 50.000đ (em lọc 40.000đ–60.000đ)");
  assert.equal(describePriceFilter(parsePriceFilter("30-50k")), "từ 30.000đ đến 50.000đ");
});

test("INTENT: operation / order / exclusion / area are read from the wording, not from any dish or place", () => {
  const i = (t) => detectIntent(normalizeInput(t));
  assert.equal(i("Bánh căn Út Năm ở đâu").operation, "address");
  assert.equal(i("địa chỉ Kiwami").operation, "address");
  assert.equal(i("Phở Hồng có giá bao nhiêu").operation, "price");
  assert.equal(i("gia bun ca").operation, "price"); // unaccented message: "gia" is "giá"
  assert.equal(i("Út Năm mấy giờ mở cửa").operation, "hours");
  assert.equal(i("Bún Cá Mịn có món gì").operation, "menu");
  assert.equal(i("Còn quán nào nữa?").operation, "more");
  for (const t of ["2 tô hủ tiếu xào bò", "cho 2 tô", "Cho tôi 2 hủ tiếu xào bò", "đặt", "thêm 1 bò"]) assert.equal(i(t).orderLike, true, t);
  for (const t of ["Bánh Căn 51 Tô Hiến Thành ở đâu?", "Mì Quảng Nam 127", "bún cá khoảng 50k"]) assert.equal(i(t).orderLike, false, t);
  assert.equal(i("Ngoài quán này ra còn quán nào bán bún cá?").exclusion.current, true);
  assert.equal(i("Ngoài quán hủ tiếu ra còn món gì?").exclusion.text, "quan hu tieu");
  assert.equal(i("Xung quanh Nha Trang có món gì?").area, true);
  assert.equal(i("Xung quanh Nha Trang có món gì?").proximity, true);
  assert.equal(i("quán bún cá gần đây").nearMe, true);
  assert.equal(i("đúng").yes, true);
  assert.equal(i("không phải").no, true);
});

test("WORD CLASSES: filler vs name words — accents decide where the folded forms collide", () => {
  const c = (text) => normalizeInput(text).tokens.map((t) => `${t.original}:${wordClass(t)[0]}`).join(" ");
  assert.equal(c("Bánh căn Út Năm ở đâu"), "Bánh:r căn:r Út:r Năm:r ở:d đâu:d");
  assert.equal(c("có Cô Ba không"), "có:d Cô:r Ba:r không:d"); // "có" is filler, "Cô" is a name word
  assert.equal(c("co ba"), "co:o ba:r"); // unaccented "co": may be "có" or "Cô" -> optional
  assert.equal(c("Nhật"), "Nhật:r"); // not "nhất"
  assert.equal(c("quán nào bán"), "quán:d nào:d bán:d");
});

test("PLACE INDEX: rare words identify; shared words do not; dish words said with the name must fit; typos only MEDIUM", () => {
  const idx = new MerchantIndex({
    merchants: [
      { id: "kb:1", name: "Phở Hồng", address: "40 Lê Thánh Tôn", kind: "kb" },
      { id: "kb:2", name: "Bún ốc Hồng Ngọc", address: "79 Hoàng Diệu", kind: "kb" },
      { id: "kb:3", name: "Nhà hàng Nhật Bản KIWAMI", address: "136 Bạch Đằng", kind: "kb" },
      { id: "kb:4", name: "Bánh bèo Phan Bội Châu", address: "101 Phan Bội Châu", kind: "kb" },
      ...Array.from({ length: 40 }, (_, k) => ({ id: `kb:${100 + k}`, name: `Quán Hải ${k}`, address: null, kind: "kb" })),
    ],
  });
  const t = (s) => normalizeInput(s).tokens;
  assert.deepEqual(idx.resolve({ required: t("Kiwami") }).candidates.map((c) => c.id), ["kb:3"]);
  assert.equal(idx.resolve({ required: t("Kiwami") }).confidence, "HIGH_CONFIDENCE");
  // "Phở Hồng": "Hồng" alone names two places; the dish said with it decides
  assert.deepEqual(idx.resolve({ required: t("Hồng"), soft: t("Phở") }).candidates.map((c) => c.id), ["kb:1"]);
  // "Bánh Mì Phan": the only "Phan" place is a bánh bèo place — the dish words disagree: no place
  assert.equal(idx.resolve({ required: t("Phan"), soft: t("Bánh Mì") }).confidence, "NO_MATCH");
  // a word 40 places share identifies none of them
  assert.equal(idx.resolve({ required: t("Hải") }).confidence, "NO_MATCH");
  // one-letter slip on a rare word: a MEDIUM candidate, never HIGH
  const slip = idx.resolve({ required: t("Kiwamy") });
  assert.equal(slip.confidence, "MEDIUM_CONFIDENCE");
  assert.deepEqual(slip.corrected, { said: "Kiwamy", as: "kiwami" });
});

test("CONTRACT: the SearchResult says what was understood, how, and with what confidence", () => {
  const catalog = [{ merchant_id: "ATIEU001", name: "Hủ Tiếu Xào A Tiểu", address: null }];
  const fk = createFoodKnowledge({ dbPath: searchV2Knowledge(), services: { merchantData: { listDiscoverable: () => catalog, getById: () => null }, menu: {} }, isRoutable: () => true });
  const si = fk.searchIntelligence();
  const r = si.understand("Nha Trang có quán bún cá nào khoảng 50k?");
  for (const k of ["query", "normalizedQuery", "foldedQuery", "intent", "entities", "filters", "plan", "matchType", "confidence", "ambiguity", "contextUsed", "explain"]) assert.ok(k in r, k);
  assert.equal(r.plan.type, "FOOD_DISCOVERY");
  assert.deepEqual(r.plan.foods.map((f) => f.key), ["bun-ca"]);
  assert.equal(r.filters.regionId, "vn.khanh-hoa.nha-trang");
  assert.deepEqual([r.filters.price.min, r.filters.price.max], [40000, 60000]);
  assert.equal(r.matchType, "EXACT_CANONICAL");
  assert.equal(r.confidence, "HIGH_CONFIDENCE");
  assert.equal(si.understand("bun ca").matchType, "APPROVED_NO_DIACRITIC");
  assert.equal(si.understand("bún bò").confidence, "AMBIGUOUS");
  assert.equal(si.understand("hu tiu").plan.reason, "DID_YOU_MEAN");
  assert.equal(si.understand("A Tiểu có bún bò không?").plan.type, "DEFER"); // a catalog place: its own path
  assert.equal(si.understand("cho 2 tô").plan.reason, "ORDER");
  // context: "quán nào bán?" inherits the dish of the conversation
  const ctx = { type: "food_knowledge_results", matchedIds: [1], shownCount: 1, total: 1, touchedAt: new Date().toISOString(), si: { v: 2, currentFoodEntity: { key: "bun-ca", name: "Bún cá", id: 1 } } };
  const follow = si.understand("Quán nào bán?", { context: ctx });
  assert.equal(follow.plan.type, "CONTEXT_DISCOVERY");
  assert.deepEqual(follow.contextUsed, ["currentFoodEntity"]);
  assert.equal(si.understand("khoảng 30k", { context: ctx }).plan.type, "PRICE_REFINE");
  assert.equal(si.understand("Quán nào bán?").plan.reason, "NO_CONTEXT"); // no list: ask, never search "nào bán"
  fk.close();
});
