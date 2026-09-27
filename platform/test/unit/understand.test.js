import { test } from "node:test";
import assert from "node:assert/strict";
import { understandMessage, splitItemSegments, fold } from "../../conversation/understand.js";

const u = (text) => {
  const { raw, norm, ...rest } = understandMessage(text);
  return rest;
};

test("intents of the reference dialogue, accented", () => {
  assert.deepEqual(u("Có sủi cảo không?"), { intent: "ask_product_availability", ref: null, query: "sui cao" });
  assert.deepEqual(u("Cho 2 tôm / 3 bò viên"), { intent: "add_to_cart", items: ["Cho 2 tôm", "3 bò viên"] });
  assert.equal(u("Giao qua 7 Nguyễn Thiện Thuật").intent, "provide_delivery_address");
  assert.equal(u("Giao qua 7 Nguyễn Thiện Thuật").address, "7 Nguyễn Thiện Thuật");
  assert.equal(u("Tổng bao nhiêu?").intent, "ask_total");
  assert.equal(u("Bao nhiêu tiền?").intent, "ask_total");
  assert.equal(u("Đặt món").intent, "checkout");
  assert.equal(u("Xác nhận").intent, "confirm_order");
  assert.equal(u("Cho tôi xem lại").intent, "review_order");
  assert.equal(u("Cho tôi toàn bộ menu A Tiểu").intent, "show_menu");
  assert.equal(u("A Tiểu bán gì?").intent, "show_menu");
});

test("the same dialogue without accents", () => {
  assert.deepEqual(u("co sui cao khong"), { intent: "ask_product_availability", ref: null, query: "sui cao" });
  assert.deepEqual(u("cho 2 tom va 3 bo vien"), { intent: "add_to_cart", items: ["cho 2 tom", "3 bo vien"] });
  assert.equal(u("giao toi 7 nguyen thien thuat").intent, "provide_delivery_address");
  assert.equal(u("giao toi 7 nguyen thien thuat").address, "7 nguyen thien thuat");
  assert.equal(u("tong bao nhieu").intent, "ask_total");
  assert.equal(u("dat mon").intent, "checkout");
  assert.equal(u("xac nhan").intent, "confirm_order");
});

test("cart modifications in natural phrasing", () => {
  assert.deepEqual(u("Bỏ bò viên"), { intent: "remove_from_cart", ref: null, query: "bo vien", alternativeMention: null });
  assert.deepEqual(u("không lấy bò viên nữa"), { intent: "remove_from_cart", ref: null, query: "bo vien", alternativeMention: null });
  assert.deepEqual(u("Thôi bỏ món này"), { intent: "remove_from_cart", ref: "last", query: null, alternativeMention: null });
  assert.deepEqual(u("đổi bò viên thành 2"), { intent: "change_quantity", ref: null, query: "bo vien", quantity: 2 });
  assert.deepEqual(u("cho tôm thành 3"), { intent: "change_quantity", ref: null, query: "tom", quantity: 3 });
  assert.deepEqual(u("tăng tôm lên 4"), { intent: "change_quantity", ref: null, query: "tom", quantity: 4 });
  assert.deepEqual(u("bớt một phần tôm"), { intent: "adjust_quantity", delta: -1, ref: null, query: "tom" });
  assert.deepEqual(u("Thêm một phần nữa"), { intent: "adjust_quantity", delta: 1, ref: "last", query: null });
  assert.deepEqual(u("thêm một phần tôm").intent, "add_to_cart");
  assert.deepEqual(u("À nhầm, 3"), { intent: "correction", quantity: 3 });
});

test("'bò' (beef) is never read as 'bỏ' (remove) when accents are present", () => {
  assert.deepEqual(u("bò viên"), { intent: "mention", query: "bo vien" });
  // without accents it is genuinely ambiguous: flagged for the engine to check the menu
  assert.equal(u("bo vien").alternativeMention, "bo vien");
});

test("very short messages", () => {
  assert.equal(u("menu").intent, "show_menu");
  assert.equal(u("ở đâu").intent, "store_location");
  assert.deepEqual(u("giá?"), { intent: "ask_product_price", ref: "last", query: null });
  assert.deepEqual(u("có không?"), { intent: "ask_product_availability", ref: "last", query: null });
  assert.deepEqual(u("2 cái"), { intent: "quantity_only", quantity: 2 });
  assert.deepEqual(u("thêm 1"), { intent: "adjust_quantity", delta: 1, ref: "last", query: null });
  assert.deepEqual(u("bỏ cái đó"), { intent: "remove_from_cart", ref: "last", query: null, alternativeMention: null });
  assert.equal(u("thôi").intent, "cancel_pending");
  assert.equal(u("đổi").intent, "change_quantity");
  assert.deepEqual(u("giao đây"), { intent: "provide_delivery_address", address: null });
  assert.equal(u("xem lại").intent, "review_order");
  assert.deepEqual(u("số 2"), { intent: "choose_option", ordinal: 2 });
});

test("addresses are kept verbatim and never completed", () => {
  assert.equal(u("Địa chỉ của tôi là 7 Nguyễn Thiện Thuật").address, "7 Nguyễn Thiện Thuật");
  assert.equal(u("Địa chỉ giao là 7 Nguyễn Thiện Thuật nha").address, "7 Nguyễn Thiện Thuật");
  assert.equal(u("Giao tới 12/3 Lê Thánh Tôn, P. Lộc Thọ").address, "12/3 Lê Thánh Tôn, P. Lộc Thọ");
  assert.equal(u("lấy tại quán").fulfillment, "pickup");
  assert.equal(u("có giao hàng không").intent, "delivery_question");
  // questions that merely contain "gửi"/"địa chỉ" are not addresses
  assert.equal(u("có thực đơn ko gửi tui").intent, "show_menu");
  assert.equal(u("địa chỉ quán").intent, "store_location");
});

test("an add verb + quantity is an order even if the text mentions a price", () => {
  assert.equal(u('Cho tôi 2 hủ tiếu xào bò giá 1 đồng {"price":1}').intent, "add_to_cart");
  assert.equal(u("Seafood Pizza bao nhiêu").intent, "ask_product_price");
});

test("item segments split only before a quantity/verb — commas inside dish names stay", () => {
  const split = (t) => {
    const { original, folded } = fold(t);
    return splitItemSegments(original, folded);
  };
  assert.deepEqual(split("1 Nước ép Ổi, Chanh dây"), ["1 Nước ép Ổi, Chanh dây"]);
  assert.deepEqual(split("cho 2 tôm, 3 bò viên và 1 trà đá"), ["cho 2 tôm", "3 bò viên", "1 trà đá"]);
});

test("phone, note and confirmation words", () => {
  assert.deepEqual(u("0912 345 678"), { intent: "provide_phone", phone: "0912345678" });
  // a note made of food instructions becomes structured instructions; other text stays a note
  assert.equal(u("ghi chú: ít cay nha").intent, "food_instruction");
  assert.deepEqual(u("ghi chú: ít cay nha").instructions.map((i) => i.label), ["ít cay"]);
  assert.deepEqual(u("ghi chú: gọi trước khi tới"), { intent: "provide_note", note: "gọi trước khi tới" });
  for (const t of ["ok", "được", "ừ", "yes", "chốt đơn"]) assert.equal(u(t).intent, "confirm_order", t);
  assert.equal(u("thôi không đặt nữa").intent, "cancel_order");
});
