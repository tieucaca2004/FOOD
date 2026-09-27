// FoodSemanticParser: natural customer language -> FoodQuery (deterministic).
import { test } from "node:test";
import assert from "node:assert/strict";
import { FoodSemanticParser } from "../../knowledge/semanticParser.js";

const parser = new FoodSemanticParser({
  foodNames: [
    { entityKey: "bun-cha-ca", name: "Bún chả cá" },
    { entityKey: "bun-cha-ca", name: "bún cá" },
    { entityKey: "nem-nuong", name: "Nem nướng" },
    { entityKey: "banh-can", name: "Bánh căn" },
    { entityKey: "com-nguoi", name: "Cơm nguội" },
  ],
  regions: [{ id: "vn.khanh-hoa.nha-trang", name: "Nha Trang" }],
});
const p = (t) => parser.parse(t);
const find = (list, concept) => list.find((x) => x.concept === concept);

test("PARSER: 'món nóng nóng, cay nhẹ, có tôm' -> soft hot, spicy low|medium, shrimp", () => {
  const q = p("Tôi muốn ăn món nóng nóng, cay nhẹ, có tôm.");
  assert.deepEqual(find(q.prefer, "temperature.serving").values, ["hot", "very_hot"]); // reduplicated: a soft wish
  assert.deepEqual(find(q.must, "taste.spicy").levels, ["low", "medium"]);
  assert.deepEqual(find(q.must, "ingredient").values, ["protein.seafood.shrimp"]);
  assert.equal(q.senses["nóng"], "temperature");
});

test("PARSER: temperature vs spicy vs traditional medicine vs dish name vs weather", () => {
  assert.deepEqual(find(p("cho tôi món nóng").must, "temperature.serving").values, ["hot", "very_hot"]);
  assert.equal(find(p("món cay nóng").must, "temperature.serving"), undefined);
  assert.deepEqual(find(p("món cay nóng").must, "taste.spicy").levels, ["high"]);
  const tcm = p("đồ ăn tính nóng");
  assert.deepEqual(tcm.outOfScope.map((o) => o.text), ["tính nóng"]);
  assert.equal(tcm.must.length + tcm.prefer.length, 0);
  const rice = p("cơm nguội");
  assert.deepEqual(rice.foods.map((f) => f.entityKey), ["com-nguoi"]);
  assert.equal(rice.must.length, 0); // not "room temperature"
  const weather = p("trời nóng quá ăn gì?");
  assert.equal(weather.context.weather, "hot");
  assert.equal(weather.must.length, 0); // a suggestion context, never a filter
  assert.ok(weather.prefer.every((x) => x.reason === "weather"));
  assert.ok(find(weather.prefer, "temperature.serving").values.includes("cold"));
});

test("PARSER: dislikes, hard exclusions and 'too much' are different things", () => {
  assert.deepEqual(find(p("tìm món không cay").avoid, "taste.spicy").levels, ["low", "medium", "high"]);
  const hard = p("tôi không ăn được cay");
  assert.equal(find(hard.mustNot, "taste.spicy").hard, true);
  assert.deepEqual(find(p("dị ứng tôm").mustNot, "ingredient").values, ["protein.seafood.shrimp"]);
  assert.deepEqual(find(p("không thích đồ quá ngọt").avoid, "taste.sweet").levels, ["high"]); // only "too sweet"
  assert.deepEqual(find(p("không hành, không ngò").avoid, "ingredient").values, ["vegetable.onion"]);
  assert.ok(find(p("tôi thích ăn cay").prefer, "taste.spicy"));
});

test("PARSER: dish names, categories, combinations, price, location, sort, open now", () => {
  const q1 = p("Tìm bún cá dưới 50k");
  assert.deepEqual(q1.foods.map((f) => f.entityKey), ["bun-cha-ca"]);
  assert.equal(q1.price.max, 50000);
  assert.equal(q1.categories.length, 0); // "bún" inside a dish name is not a category filter
  const q2 = p("Tìm quán bún cá gần Trần Phú");
  assert.equal(q2.intent, "find_merchant");
  assert.equal(q2.location.text, "Trần Phú");
  assert.ok(q2.sort.includes("distance_asc"));
  const q3 = p("Quán nào bán bún cá và nem nướng?");
  assert.deepEqual(q3.foods.map((f) => f.entityKey).sort(), ["bun-cha-ca", "nem-nuong"]);
  assert.equal(q3.combine, "all");
  assert.deepEqual(p("Tìm bánh giòn").categories, [{ facet: "lexical_family", value: "banh" }]);
  assert.ok(find(p("Tìm bánh giòn").must, "texture.crispy"));
  assert.equal(p("Tìm quán hải sản đang mở").openNow, true);
  assert.deepEqual(find(p("Tìm quán hải sản đang mở").must, "ingredient").values, ["protein.seafood"]);
  assert.deepEqual(p("Tìm quán có rating cao bán bún cá").sort, ["rating_desc"]);
  assert.deepEqual(p("quán nào nhiều đánh giá").sort, ["review_count_desc"]);
  assert.deepEqual(p("quán nhiều món").sort, ["menu_count_desc"]);
  assert.deepEqual(p("bún cá giá rẻ").sort, ["price_asc"]);
  assert.equal(p("tìm bún cá ở Nha Trang").location.regionId, "vn.khanh-hoa.nha-trang");
  assert.equal(p("quán gần tôi").location.nearMe, true);
  assert.equal(find(p("món gì đặc sản Nha Trang").must, "relation:regional_specialty").values[0], "vn.khanh-hoa.nha-trang");
  assert.ok(find(p("tìm món ăn sáng").must, "facet:meal_period"));
  assert.ok(find(p("tìm món Trung Hoa").must, "facet:cuisine"));
  assert.ok(find(p("muốn ăn món có nước").prefer, "facet:dish_form"));
});

test("PARSER: no ranking from taste words; ordering intent is only flagged", () => {
  const q = p("Bún cá ở đâu ngon?");
  assert.equal(q.subjective, true);
  assert.deepEqual(q.sort, []);
  assert.equal(p("đặt 2 tô bún cá").intent, "order");
});

test("PARSER: accents optional, colliding words flagged instead of trusted", () => {
  const q = p("bun ca chua");
  assert.deepEqual(q.foods.map((f) => f.entityKey), ["bun-cha-ca"]);
  assert.equal(find(q.must, "taste.sour"), undefined);
  assert.ok(q.ambiguous.some((a) => a.text === "chua"));
  assert.ok(find(p("mon nong").must, "temperature.serving"));
  assert.ok(find(p("tôi muốn ăn cái gì nhẹ nhẹ").prefer, "taste.light"));
});

test("PARSER: 'Nha Trang' is the place — never the dish alias 'tràng' (Lòng lợn)", () => {
  const nt = new FoodSemanticParser({
    foodNames: [
      { entityKey: "bun-ca", name: "Bún cá" },
      { entityKey: "long-lon", name: "tràng" },
    ],
    regions: [{ id: "vn.khanh-hoa.nha-trang", name: "Nha Trang" }],
  });
  for (const t of ["Nha Trang", "ở Nha Trang", "quán ăn Nha Trang", "bún cá Nha Trang", "hải sản Nha Trang", "nha trang"]) {
    const q = nt.parse(t);
    assert.equal(q.location.regionId, "vn.khanh-hoa.nha-trang", t);
    assert.ok(!q.foods.some((f) => f.entityKey === "long-lon"), t);
  }
  assert.deepEqual(nt.parse("bún cá Nha Trang").foods.map((f) => f.entityKey), ["bun-ca"]);
  assert.deepEqual(nt.parse("Tìm quán bún cá ở Nha Trang").foods.map((f) => f.entityKey), ["bun-ca"]);
  assert.deepEqual(nt.parse("món tràng").foods.map((f) => f.entityKey), ["long-lon"]); // the dish is still findable
});
