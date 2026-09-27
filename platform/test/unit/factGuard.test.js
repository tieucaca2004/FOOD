// FACT GUARD: the model's prose may not carry business facts the tools did not return; every
// fact the customer sees is rendered from the ledger. Records below are SYNTHETIC FIXTURES.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Ledger, checkAnswer, renderAnswer, moneyAmounts } from "../../ai/foodConcierge/factGuard.js";
import { priceStatus } from "../../ai/foodConcierge/foodTools.js";

function ledger() {
  const l = new Ledger();
  l.add([
    {
      id: "kb:1",
      name: "Quán Mẫu Một",
      address: "1 Đường Thử, Phường Thử",
      orderable: false,
      openStatus: "unknown",
      openingHours: [],
      ratings: [],
      products: [
        { id: "kbp:10", name: "Bún mẫu", priceStatus: "available", prices: [{ variant: null, price: 45000, price_max: null, source: "https://quanmau.example/menu", captured_at: "2026-09-26T00:00:00Z" }], orderable: false },
        { id: "kbp:11", name: "Bún mẫu đặc biệt", priceStatus: "unavailable", prices: [], orderable: false },
        { id: "kbp:12", name: "Món mâu thuẫn", priceStatus: "conflicting", prices: [{ variant: null, price: 165000, source: "https://quanmau.example/menu", captured_at: "2026-09-26T00:00:00Z" }, { variant: null, price: 195000, source: "https://quanmau.example/menu", captured_at: "2026-09-26T00:00:00Z" }], orderable: false },
      ],
    },
    {
      id: "cat:SHOP1",
      name: "Cửa Hàng Đặt Được",
      address: null,
      orderable: true,
      openStatus: "unknown",
      openingHours: [],
      ratings: [],
      products: [{ id: "catp:SHOP1:0", name: "Pizza mẫu", priceStatus: "available", prices: [{ price: 100000, source: "FOOD catalog" }], orderable: true }],
    },
  ]);
  return l;
}
const answer = (reply, items = [{ merchant_id: "kb:1", product_ids: ["kbp:10"], note: "" }]) => ({ reply, items });

test("GUARD: a clean answer passes; the rendered text carries tool facts only", () => {
  const l = ledger();
  const a = answer("Dạ em tìm được quán này ạ.", [
    { merchant_id: "kb:1", product_ids: ["kbp:10", "kbp:11", "kbp:12"], note: "" },
    { merchant_id: "cat:SHOP1", product_ids: ["catp:SHOP1:0"], note: "" },
  ]);
  assert.deepEqual(checkAnswer(a, l, { userText: "tìm bún" }), []);
  const text = renderAnswer(a, l);
  assert.match(text, /📍 Quán Mẫu Một\n📌 1 Đường Thử, Phường Thử/);
  assert.match(text, /🍜 Bún mẫu\n💰 45\.000đ\n🔗 quanmau\.example · 🕒 ghi nhận 26\/09\/2026/);
  assert.match(text, /🍜 Bún mẫu đặc biệt\n⚠️ Chưa có giá xác thực từ nguồn hiện có\./); // price null -> never a price
  assert.match(text, /⚠️ Các nguồn đang ghi giá khác nhau: 165\.000đ \/ 195\.000đ — em không chọn giá nào\./);
  assert.match(text, /ℹ️ Thông tin tham khảo — chưa đặt qua FOOD được\./); // reference, not orderable
  assert.match(text, /📍 Cửa Hàng Đặt Được\n📌 Chưa có địa chỉ trong nguồn hiện có[\s\S]*💰 100\.000đ\n🔗 Giá trên FOOD\n✅ Đặt được qua FOOD/);
});

test("GUARD: invented prices, typical prices and conversions are blocked; the customer's own budget is not", () => {
  const l = ledger();
  assert.match(checkAnswer(answer("Món này giá 50.000đ."), l).join(), /UNSUPPORTED_PRICE/);
  assert.match(checkAnswer(answer("Thường khoảng 40k thôi."), l).join(), /UNSUPPORTED_PRICE 40k/);
  assert.match(checkAnswer(answer("Tầm 1 triệu."), l).join(), /UNSUPPORTED_PRICE/);
  assert.deepEqual(checkAnswer(answer("Quán này ghi 45.000đ."), l), []); // recorded
  assert.deepEqual(checkAnswer(answer("Dưới 50k em chỉ tìm được quán này."), l, { userText: "bún dưới 50k" }), []); // the budget the customer said
  assert.deepEqual(moneyAmounts("45.000đ, 50k, 1,5 triệu").map((a) => a.value), [45000, 50000, 1500000]);
});

test("GUARD: orderability, open-now, hours, ratings and ranking need data; negations are fine", () => {
  const l = ledger();
  const ref = (reply) => checkAnswer(answer(reply), l).join();
  assert.match(checkAnswer(answer("Anh đặt được luôn ạ."), withoutCatalog()).join(), /UNSUPPORTED_ORDERABILITY/);
  assert.equal(ref("Quán này chưa đặt qua FOOD được ạ."), ""); // a negation is not a claim
  assert.match(ref("Quán đang mở đó anh."), /UNSUPPORTED_OPEN_NOW/);
  assert.match(ref("Quán mở cửa từ 6h."), /UNSUPPORTED_OPENING_HOURS/);
  assert.match(ref("Quán được 4.5/5 sao."), /UNSUPPORTED_RATING/);
  assert.match(ref("Đây là quán ngon nhất."), /RANKING_NOT_ALLOWED/);
});

test("GUARD: unknown ids and invented names are blocked; names from the ledger or the customer pass", () => {
  const l = ledger();
  assert.match(checkAnswer(answer("Dạ.", [{ merchant_id: "kb:999", product_ids: [], note: "" }]), l).join(), /UNKNOWN_MERCHANT kb:999/);
  assert.match(checkAnswer(answer("Dạ.", [{ merchant_id: "kb:1", product_ids: ["kbp:999"], note: "" }]), l).join(), /UNKNOWN_PRODUCT kbp:999/);
  assert.match(checkAnswer(answer("Dạ.", [{ merchant_id: "kb:1", product_ids: ["catp:SHOP1:0"], note: "" }]), l).join(), /UNKNOWN_PRODUCT/); // another place's product
  assert.match(checkAnswer(answer("Anh thử Quán Hoàng Gia Mới nha."), l).join(), /UNSUPPORTED_NAME Quán Hoàng Gia Mới/);
  assert.deepEqual(checkAnswer(answer("Quán Mẫu Một ở Phường Thử ạ."), l), []);
  assert.deepEqual(checkAnswer(answer("Ở Thành Phố Biển em tìm được quán này."), l, { userText: "tìm bún ở Thành Phố Biển" }), []);
  assert.deepEqual(checkAnswer({ nope: 1 }, l), ["ANSWER_NOT_IN_SCHEMA"]);
});

test("PRICE STATUS: available / unavailable / conflicting — variants are not conflicts", () => {
  assert.equal(priceStatus([]), "unavailable");
  assert.equal(priceStatus([{ price: null }]), "unavailable");
  assert.equal(priceStatus([{ variant: null, price: 45000 }]), "available");
  assert.equal(priceStatus([{ variant: "Small", price: 55000 }, { variant: "Big", price: 80000 }]), "available");
  assert.equal(priceStatus([{ variant: null, price: 165000 }, { variant: null, price: 195000 }]), "conflicting");
});

function withoutCatalog() {
  const l = ledger();
  l.merchants.delete("cat:SHOP1");
  return l;
}

// GPT-2 evidence (2026-09-26): each of these passed the guard before — a price borrowed from another place,
// an invented source, an invented capture date, a reference price called "current".
test("GUARD (GPT-2): prices are scoped to what is shown; sources, dates and 'current price' need data", () => {
  const l = new Ledger();
  l.add([
    { id: "kb:1", name: "Quán Có Giá", address: "1 A", orderable: false, openStatus: "unknown", openingHours: [], ratings: [], products: [{ id: "kbp:10", name: "Bún mẫu", priceStatus: "available", prices: [{ price: 45000, source: "https://quanmau.example/menu", captured_at: "2026-09-26T00:20:33Z" }] }] },
    { id: "kb:2", name: "Quán Không Giá", address: "2 B", orderable: false, openStatus: "unknown", openingHours: [], ratings: [], products: [{ id: "kbp:20", name: "Bún mẫu", priceStatus: "unavailable", prices: [] }] },
    { id: "cat:S", name: "Cửa Hàng", address: null, orderable: true, openStatus: "unknown", openingHours: [], ratings: [], products: [{ id: "catp:S:0", name: "Pizza mẫu", priceStatus: "available", prices: [{ price: 100000, source: "FOOD catalog" }] }] },
  ]);
  const unpriced = [{ merchant_id: "kb:2", product_ids: ["kbp:20"], note: "" }];
  const priced = [{ merchant_id: "kb:1", product_ids: ["kbp:10"], note: "" }];
  const catalog = [{ merchant_id: "cat:S", product_ids: ["catp:S:0"], note: "" }];
  const check = (reply, items) => checkAnswer({ reply, items }, l, { userText: "tìm bún dưới 50k" }).join();
  assert.match(check("Bún mẫu ở quán này giá 45.000đ.", unpriced), /UNSUPPORTED_PRICE 45\.000đ/); // another place's price
  assert.equal(check("Bún mẫu ở quán này chưa có giá xác thực.", unpriced), "");
  assert.equal(check("Quán này có giá 45.000đ.", priced), "");
  assert.match(check("Theo nguồn foody.vn, món này có.", priced), /UNSUPPORTED_SOURCE foody\.vn/);
  assert.match(check("Theo nguồn Foody thì món này có.", priced), /UNSUPPORTED_SOURCE Foody/);
  assert.equal(check("Theo nguồn quanmau.example, giá ghi nhận ngày 26/09.", priced), "");
  assert.match(check("Giá được ghi nhận ngày 01/01/2024.", priced), /UNSUPPORTED_DATE 01\/01\/2024/);
  assert.match(check("Giá ghi nhận ngày 3 tháng 4.", priced), /UNSUPPORTED_DATE/);
  assert.match(check("Giá hiện tại là 45.000đ.", priced), /UNSUPPORTED_CURRENT_PRICE/); // a recorded reference price is not "current"
  assert.equal(check("Giá hiện tại trên FOOD là 100.000đ.", catalog), ""); // the catalog price is FOOD's own
  assert.equal(check("Dưới 50k em chỉ tìm được quán này.", priced), ""); // the customer's own budget
});
