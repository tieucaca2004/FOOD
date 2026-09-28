// FORM 15C — the Fact Guard's sentence boundary: a "." between digits is a Vietnamese thousands separator, never a
// sentence end — so a customer-attributed price list stays ONE attribution context, while a real sentence end still
// separates sentences (an unattributed price in the next sentence is still refused).
import { test } from "node:test";
import assert from "node:assert/strict";
import { Ledger, checkAnswer } from "../../ai/foodConcierge/factGuard.js";

/** the customer's photo / message said these amounts (unverified customer values, never FOOD's) */
const guard = (reply, amounts, contextText = "") => {
  const ledger = new Ledger();
  ledger.add(amounts.map((value) => ({ kind: "contribution", value, value_max: null })));
  return checkAnswer({ reply, items: [] }, ledger, { userText: "", contextText });
};

test("A / B / C dotted thousands inside an attributed list stay attributed", () => {
  assert.deepEqual(guard("Ảnh anh/chị gửi có ghi Bánh hỏi 40.000đ, Bún chả 50K.", [40000, 50000]), []); // A
  assert.deepEqual(guard("Ảnh anh/chị gửi có ghi Phở bò 50.000đ, Phở gà 45.000đ.", [50000, 45000]), []); // B
  assert.deepEqual(guard("Ảnh anh/chị gửi có ghi 1.200.000đ.", [1200000]), []); // C (the final "." still ends it)
  assert.deepEqual(guard("Dạ, ảnh anh/chị gửi có ghi Bún bò Huế 45K, Bánh hỏi 40.000đ, Bún chả 50K, Trà đá 5K ạ.", [45000, 40000, 50000, 5000]), []);
});

test("D a real sentence boundary still separates sentences", () => {
  // (the place name is known context here: only the sentence boundary is under test)
  assert.deepEqual(guard("Ảnh anh/chị gửi có ghi Bún bò 45.000đ. Quán nằm ở Nha Trang.", [45000], "Nha Trang"), []);
  // the price in the NEXT sentence has no attribution of its own: still refused
  assert.deepEqual(guard("Ảnh anh/chị gửi có ghi Bún bò 45.000đ. Bún chả 50K.", [45000, 50000]), ["UNATTRIBUTED_CANDIDATE 50K"]);
  assert.deepEqual(guard("Ảnh anh/chị gửi có ghi Bún bò 45.000đ! Giá hiện tại là 50.000đ.", [45000, 50000]), ["UNATTRIBUTED_CANDIDATE 50.000đ"]);
});

test("UNCHANGED: an attributed amount stated as the place's current / official price is still refused", () => {
  assert.deepEqual(guard("Ảnh anh/chị gửi có ghi giá chính thức 40.000đ, Bún chả 50K.", [40000, 50000]).map((v) => v.split(" ")[0]), ["UNATTRIBUTED_CANDIDATE", "UNATTRIBUTED_CANDIDATE"]);
  assert.deepEqual(guard("Bánh hỏi 40.000đ.", [40000]), ["UNATTRIBUTED_CANDIDATE 40.000đ"], "no attribution at all");
});
