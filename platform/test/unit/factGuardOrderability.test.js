// FORM 15D — UNSUPPORTED_ORDERABILITY precision. A CLAIM that a place / dish is orderable or delivered needs an orderable
// place in this turn's data; a QUESTION or an OFFER that only mentions ordering ("anh/chị có muốn em tìm quán để đặt món
// không?", "nếu muốn đặt món…", "em có thể giúp … đặt món", "muốn hỏi quán nào có ship không?") claims nothing; a
// negation ("chưa đặt được") was never a claim.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Ledger, checkAnswer } from "../../ai/foodConcierge/factGuard.js";

const place = (orderable) => ({ id: orderable ? "cat:S" : "kb:1", name: "Quán Mẫu", address: "1 A", orderable, openStatus: "unknown", openingHours: [], ratings: [], products: [] });
const verdict = (reply, { orderable = false, shown = false } = {}) => {
  const ledger = new Ledger();
  ledger.add([place(orderable)]);
  const items = shown ? [{ merchant_id: orderable ? "cat:S" : "kb:1", product_ids: [], note: "" }] : [];
  return checkAnswer({ reply, items }, ledger, { userText: "", contextText: "Quán Mẫu" }).includes("UNSUPPORTED_ORDERABILITY") ? "BLOCKED" : "ok";
};

const MATRIX = {
  // A. conversational question / offer -> never a claim
  A: ["Anh/chị có muốn em tìm quán để đặt món không ạ?", "Dạ, anh/chị có muốn đặt món ở quán này không ạ?"],
  // B. conditional / help wording -> never a claim
  B: ["Nếu anh/chị muốn đặt món, cho em biết tên món nhé.", "Dạ, em có thể giúp anh/chị tìm và đặt món nếu anh/chị cho em biết tên món ạ.", "Dạ, em chưa đọc được chữ nào trong ảnh. Nếu anh/chị muốn đặt món, anh/chị cho em biết tên món nhé."],
  // E. "ship" asked about -> never a claim
  E: ["Anh/chị muốn hỏi quán nào có ship không ạ?", "Dạ, quán nào có ship ạ?"],
  // D. negative statements -> allowed (unchanged)
  D: ["Dạ, quán trong ảnh chưa đặt được qua FOOD ạ.", "Dạ, hiện em không thể đặt món ở quán này qua FOOD ạ.", "Quán này chưa đặt qua FOOD được ạ."],
  // C. explicit place / dish orderability claim -> BLOCKED without an orderable place
  C: ["Quán này đặt được qua FOOD.", "Quán hiện có thể đặt món.", "Món này đặt được qua FOOD ngay.", "Anh đặt được luôn ạ.", "Dạ, quán này đặt được qua FOOD, anh/chị có muốn đặt không ạ?", "Nếu anh/chị ở gần, quán này giao tận nơi."],
  // F. positive shipping / delivery claim -> BLOCKED without an orderable place
  F: ["Quán này có giao hàng.", "Dạ, quán này giao tận nơi ạ.", "Quán có ship ạ."],
};

test("A / B / E questions and offers that mention ordering are NOT claims (no orderable place needed)", () => {
  for (const group of ["A", "B", "E"]) for (const reply of MATRIX[group]) assert.equal(verdict(reply), "ok", `${group}: ${reply}`);
});

test("D negative statements stay allowed", () => {
  for (const reply of MATRIX.D) assert.equal(verdict(reply), "ok", reply);
});

test("C / F real orderability and delivery claims stay BLOCKED without orderable evidence — and pass with it", () => {
  for (const group of ["C", "F"]) {
    for (const reply of MATRIX[group]) {
      assert.equal(verdict(reply), "BLOCKED", `${group}: ${reply}`);
      assert.equal(verdict(reply, { orderable: true, shown: true }), "ok", `${group} with an orderable place: ${reply}`);
    }
  }
});

test("UNCHANGED: the other guards still fire in the same answers", () => {
  const ledger = new Ledger();
  ledger.add([place(false)]);
  const v = checkAnswer({ reply: "Dạ, anh/chị có muốn đặt món không ạ? Quán giá 99.000đ, ngon nhất Nha Trang.", items: [] }, ledger, { userText: "" });
  assert.ok(v.some((x) => x.startsWith("UNSUPPORTED_PRICE")) && v.includes("RANKING_NOT_ALLOWED"), JSON.stringify(v));
  assert.ok(!v.includes("UNSUPPORTED_ORDERABILITY"));
});

export { MATRIX, verdict };
