import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizePhrase, displayPhrase, computeConfidence, computeStatus } from "../../services/productLanguageService.js";
import { typoCandidates, levenshtein } from "../../nlp/fuzzyMatch.js";
import { understandMessage, yesNoAnswer } from "../../conversation/understand.js";

test("normalization: case, accents, whitespace, quantity and filler never part of a phrase", () => {
  for (const t of ["Pizza Hải Sản", "pizza hải sản", "pizza hai san", "PIZZA HẢI SẢN", "  pizza   hải  sản  "]) {
    assert.equal(normalizePhrase(t), "pizza hai san", t);
  }
  assert.equal(normalizePhrase("cho 2 pizza hải sản"), "pizza hai san");
  assert.equal(normalizePhrase("Cho tui 2 cái PIZZA Tôm nha"), "pizza tom");
  assert.equal(normalizePhrase("lấy 3 coca"), "coca");
  assert.equal(normalizePhrase("cho tôi 2 phần"), null); // nothing product-like left
  // folded number words collide with food words, so they are kept: "hải sản" is not "2 sản"
  assert.equal(normalizePhrase("hải sản"), "hai san");
  assert.equal(normalizePhrase("cho 2 cái hải sản"), "hai san");
  assert.equal(normalizePhrase("nấm"), "nam");
  assert.equal(normalizePhrase("a b c d e f g h"), null); // a sentence, not a product phrase
});

test("display form keeps the customer's accents, without quantity/filler", () => {
  assert.equal(displayPhrase("Cho tui 2 cái Pizza Tôm nha", "pizza tom"), "pizza tôm");
  assert.equal(displayPhrase("no match here", "pizza tom"), "pizza tom");
});

test("confidence: confirmations raise it, a rejection costs double", () => {
  assert.equal(computeConfidence({ confirmed: 0, rejected: 0 }), 0);
  assert.equal(computeConfidence({ confirmed: 2, rejected: 0 }), 0.5);
  assert.equal(computeConfidence({ confirmed: 6, rejected: 0 }), 0.75);
  assert.ok(computeConfidence({ confirmed: 6, rejected: 1 }) < computeConfidence({ confirmed: 6, rejected: 0 }));
});

test("status: OBSERVED -> CONFIRMED -> TRUSTED needs evidence from several customers; rejections demote/suppress", () => {
  assert.equal(computeStatus({ confirmed: 1, rejected: 0, distinctCustomers: 1 }), "OBSERVED");
  assert.equal(computeStatus({ confirmed: 2, rejected: 0, distinctCustomers: 1 }), "CONFIRMED");
  // one customer alone can never make an alias trusted
  assert.equal(computeStatus({ confirmed: 20, rejected: 0, distinctCustomers: 1 }), "CONFIRMED");
  assert.equal(computeStatus({ confirmed: 6, rejected: 0, distinctCustomers: 2 }), "TRUSTED");
  assert.equal(computeStatus({ confirmed: 6, rejected: 1, distinctCustomers: 3 }), "CONFIRMED"); // 6/10 < 0.7
  assert.equal(computeStatus({ confirmed: 2, rejected: 1, distinctCustomers: 1 }), "OBSERVED"); // demoted
  assert.equal(computeStatus({ confirmed: 2, rejected: 3, distinctCustomers: 2 }), "SUPPRESSED");
});

test("typo matching: small edits per word, every typed word must be found", () => {
  assert.equal(levenshtein("piza", "pizza"), 1);
  const products = [{ name: "Seafood Pizza - Pizza Hải Sản 28cm" }, { name: "COCA COLA 320ML" }, { name: "Macaroni - Nui Hải Sản" }];
  assert.deepEqual(typoCandidates("piza hai san", products).map((p) => p.name), ["Seafood Pizza - Pizza Hải Sản 28cm"]);
  assert.deepEqual(typoCandidates("coka", products).map((p) => p.name), ["COCA COLA 320ML"]);
  assert.deepEqual(typoCandidates("sushi", products), []);
});

test("negation and yes/no answers", () => {
  assert.deepEqual(understandMessage("Không, pizza bò").replacement, "pizza bò");
  assert.equal(understandMessage("Không, pizza bò").intent, "negation");
  assert.equal(understandMessage("không phải món đó").intent, "negation");
  assert.equal(understandMessage("sai rồi").intent, "negation");
  assert.equal(understandMessage("không lấy bò viên nữa").intent, "remove_from_cart"); // not a negation
  assert.notEqual(understandMessage("không").intent, "negation"); // a bare "không" rejects nothing on its own
  assert.equal(yesNoAnswer("đúng rồi"), true);
  assert.equal(yesNoAnswer("dung"), true);
  assert.equal(yesNoAnswer("không phải"), false);
  assert.equal(yesNoAnswer("cho 2 pizza"), null);
});
