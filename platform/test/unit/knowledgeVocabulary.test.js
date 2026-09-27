// Food Intelligence P0 — the semantic vocabulary (lexicon/vocabulary.json)
// and its matcher: Vietnamese phrases -> taxonomy concepts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { FoodTaxonomy } from "../../knowledge/taxonomy.js";
import { FoodVocabulary, loadVocabularyJson, validateVocabulary } from "../../knowledge/vocabulary.js";

const taxonomy = new FoodTaxonomy();
const vocab = new FoodVocabulary(undefined, taxonomy);
const m = (text) => vocab.match(text).matches;
const find = (text, concept) => m(text).filter((x) => x.concept === concept);

test("VOCABULARY: every term maps to a real taxonomy concept", () => {
  assert.deepEqual(validateVocabulary(loadVocabularyJson(), taxonomy), []);
  const bad = loadVocabularyJson();
  bad.terms.push({ text: "siêu ngon", concept: "taste.delicious" }, { text: "tôm hùm", concept: "ingredient", value: "protein.lobster" });
  const problems = validateVocabulary(bad, taxonomy).join("\n");
  assert.match(problems, /unknown attribute "taste.delicious"/);
  assert.match(problems, /unknown ingredient "protein.lobster"/);
});

test("TEMPERATURE: nóng / ấm / nguội / mát / lạnh / đá", () => {
  const temp = (text) => find(text, "temperature.serving").map((x) => x.value);
  assert.deepEqual(temp("món này ăn nóng mới ngon"), ["hot"]);
  assert.deepEqual(temp("nóng hổi"), ["very_hot"]);
  assert.deepEqual(temp("dùng ấm"), ["warm"]);
  assert.deepEqual(temp("để nguội ăn vẫn ngon"), ["room"]);
  assert.deepEqual(temp("uống mát"), ["cool"]);
  assert.deepEqual(temp("dùng lạnh"), ["cold"]);
  assert.deepEqual(temp("trà có đá"), ["iced"]);
  assert.deepEqual(temp("nóng hoặc đá"), ["either"]);
});

test("TEMPERATURE vs SPICY: 'nóng' is heat of the dish unless it is the burn of chili", () => {
  assert.deepEqual(m("ăn nóng").map((x) => x.concept), ["temperature.serving"]);
  assert.deepEqual(m("vị cay nóng").map((x) => [x.concept, x.level]), [["taste.spicy", "high"]]);
  assert.deepEqual(m("nóng cay").map((x) => x.concept), ["taste.spicy"]);
  assert.deepEqual(m("vị nóng").map((x) => x.concept), ["taste.spicy"]);
  // "nóng nóng, cay cay": hot AND a bit spicy — the doubled words are not glued into "nóng cay"
  assert.deepEqual(
    m("cho tôi món gì nóng nóng cay cay").map((x) => [x.concept, x.reduplicated]),
    [["temperature.serving", true], ["taste.spicy", true]]
  );
});

test("OUT OF SCOPE: 'tính nóng/tính mát' (Đông y) is recognized and never read as temperature", () => {
  for (const text of ["đồ ăn tính nóng", "món này có tính mát", "ăn nhiều bị nóng trong người", "uống cho giải nhiệt"]) {
    const r = vocab.match(text);
    assert.equal(r.outOfScope.length, 1, text);
    assert.equal(r.matches.filter((x) => x.concept === "temperature.serving").length, 0, text);
  }
});

test("PROTECTED NAMES: dish names are not attributes or ingredients", () => {
  const r1 = vocab.match("cơm nguội");
  assert.deepEqual(r1.protected.map((p) => p.text), ["cơm nguội"]);
  assert.equal(r1.matches.length, 0);
  assert.equal(find("bánh bò rất mềm", "ingredient").length, 0); // no beef in bánh bò
  assert.equal(find("bò bía cuốn", "ingredient").length, 0);
  assert.equal(find("bánh bèo", "taste.rich").length, 0);
  assert.equal(find("bánh da lợn", "ingredient").length, 0);
});

test("TASTE: dimensions, levels, intensifiers, combinations", () => {
  const lv = (text, concept) => find(text, concept).map((x) => x.level);
  assert.deepEqual(lv("hơi cay", "taste.spicy"), ["low"]);
  assert.deepEqual(lv("rất cay", "taste.spicy"), ["high"]);
  assert.deepEqual(lv("cay lắm", "taste.spicy"), ["high"]);
  assert.deepEqual(lv("cay", "taste.spicy"), [null]); // plain mention: no level asserted
  assert.deepEqual(lv("ớt để riêng", "taste.spicy"), ["adjustable"]);
  assert.deepEqual(m("chua cay").map((x) => x.concept).sort(), ["taste.sour", "taste.spicy"]);
  assert.deepEqual(m("nước dùng ngọt thanh").map((x) => [x.concept, x.level]), [["taste.sweet", "low"], ["taste.light", null]]);
  for (const [text, concept] of [["mặn", "taste.salty"], ["đắng", "taste.bitter"], ["béo ngậy", "taste.rich"], ["đậm đà", "taste.bold"], ["thanh", "taste.light"]]) {
    assert.equal(find(text, concept).length, 1, text);
  }
});

test("NEGATION: 'không cay', 'không có tôm' — within the clause only", () => {
  assert.equal(find("không cay", "taste.spicy")[0].negated, true);
  assert.equal(find("món này không có tôm", "ingredient")[0].negated, true);
  assert.equal(find("không bị mặn", "taste.salty")[0].negated, true);
  // a negation in another clause does not reach the term
  assert.equal(find("không hành, cay vừa", "taste.spicy")[0].negated, false);
  // "chả cá" is a dish word, not the negator "chả"
  assert.equal(find("chả cá cay", "taste.spicy")[0].negated, false);
});

test("TEXTURE: giòn / mềm / dai / dẻo / giòn ngoài mềm trong / nhiều nước / sệt / loãng", () => {
  for (const [text, concept] of [
    ["giòn rụm", "texture.crispy"],
    ["mềm mịn", "texture.soft"],
    ["sợi dai", "texture.chewy"],
    ["dẻo", "texture.sticky"],
    ["giòn ngoài mềm trong", "texture.crispy_outside_soft_inside"],
    ["nhiều nước", "texture.soupy"],
    ["sệt", "texture.thick"],
    ["loãng", "texture.thin"],
  ]) {
    assert.equal(find(text, concept).length, 1, text);
  }
});

test("DISH FORM, PREPARATION, MEAL PERIOD, COURSE, BÁNH", () => {
  const facet = (text, f) => find(text, `facet:${f}`).map((x) => x.value);
  assert.deepEqual(facet("món nước", "dish_form"), ["soup_dish"]);
  assert.deepEqual(facet("món khô", "dish_form"), ["dry_dish"]);
  assert.deepEqual(facet("chiên, xào, nướng, hấp, luộc, kho, hầm", "preparation"), ["fry", "stir_fry", "grill", "steam", "boil", "braise", "stew"]);
  assert.deepEqual(facet("bánh nướng khuôn", "preparation"), ["mold_bake"]);
  assert.deepEqual(facet("ăn sáng hoặc ăn khuya", "meal_period"), ["breakfast", "late_night"]);
  assert.deepEqual(facet("tráng miệng", "course"), ["dessert"]);
  // "bánh" is recognized as a word family; specific bánh are their own carb bases
  assert.deepEqual(facet("tôi muốn ăn bánh", "lexical_family"), ["banh"]);
  assert.deepEqual(facet("bánh canh", "carb_base"), ["banh_canh"]);
  assert.deepEqual(facet("bánh mì", "carb_base"), ["banh_mi"]);
  assert.deepEqual(facet("bánh hỏi", "carb_base"), ["banh_hoi"]);
});

test("INGREDIENTS: proteins, seafood, herbs, and longest-match ('mắm tôm' is not shrimp)", () => {
  const ing = (text) => find(text, "ingredient").map((x) => x.value);
  assert.deepEqual(ing("có tôm, mực và ghẹ"), ["protein.seafood.shrimp", "protein.seafood.squid", "protein.seafood.swimming_crab"]);
  assert.deepEqual(ing("bún chả cá"), ["protein.seafood.fish_cake"]);
  assert.deepEqual(ing("chấm mắm tôm"), ["condiment.shrimp_paste"]);
  assert.deepEqual(ing("không ngò, không đậu phộng"), ["vegetable.herb.cilantro", "nut.peanut"]);
  assert.deepEqual(ing("thịt bò"), ["protein.beef"]);
});

test("ACCENTS: unaccented input still matches, but colliding words are ambiguous", () => {
  assert.equal(find("an nong", "temperature.serving")[0].value, "hot");
  assert.equal(find("an nong", "temperature.serving")[0].ambiguous, false);
  // chua = chua (sour) or chưa (not yet)
  assert.equal(find("bun chua", "taste.sour")[0].ambiguous, true);
  // accented "chưa" is not "chua"
  assert.equal(find("bún chưa có", "taste.sour").length, 0);
  // kho (braise) / khô (dry)
  const kho = m("ca kho to").find((x) => x.text === "kho");
  assert.equal(kho.ambiguous, true);
  assert.ok(kho.alternatives.length >= 1);
  assert.equal(find("cá kho tộ", "facet:preparation")[0].ambiguous, false);
  // cơm chay / cơm cháy
  assert.equal(find("com chay", "facet:dietary")[0].ambiguous, true);
  assert.equal(find("cơm cháy", "facet:dietary").length, 0);
});

test("ACCENTS: words ambiguous even with accents are never clean evidence (giá, thơm, lạc)", () => {
  assert.equal(find("giá bao nhiêu", "ingredient")[0].ambiguous, true); // price, not bean sprouts
  assert.equal(find("gỏi thơm", "taste.aromatic")[0].ambiguous, true); // pineapple
  assert.equal(find("rang lạc", "ingredient")[0].ambiguous, true);
});

test("NORMALIZATION: case, spacing and punctuation do not matter", () => {
  assert.deepEqual(m("  MÓN   NƯỚC,  ĂN   NÓNG!! ").map((x) => x.concept), ["facet:dish_form", "temperature.serving"]);
});
