// Food Intelligence P0 — the reviewed taxonomy (platform/knowledge/lexicon/taxonomy.json).
import { test } from "node:test";
import assert from "node:assert/strict";
import { FoodTaxonomy, loadTaxonomyJson, validateTaxonomy } from "../../knowledge/taxonomy.js";

const t = new FoodTaxonomy();

test("TAXONOMY: the shipped taxonomy is structurally valid (unique keys, known parents, no cycles)", () => {
  assert.deepEqual(validateTaxonomy(loadTaxonomyJson()), []);
});

test("TAXONOMY: invalid documents are refused", () => {
  const bad = loadTaxonomyJson();
  bad.facets.dish_form.nodes.push({ key: "soup_dish", label_vi: "trùng" });
  bad.ingredients.push({ key: "protein.x", label_vi: "x", parent: "protein.nope" });
  bad.ingredients.push({ key: "loop.a", label_vi: "a", parent: "loop.b" }, { key: "loop.b", label_vi: "b", parent: "loop.a" });
  const problems = validateTaxonomy(bad).join("\n");
  assert.match(problems, /duplicate node "soup_dish"/);
  assert.match(problems, /unknown parent "protein.nope"/);
  assert.match(problems, /cycle/);
  assert.throws(() => new FoodTaxonomy(bad), /invalid taxonomy/);
});

test("TAXONOMY: covers the required facets — dish form, carb base, bánh, preparation, course, meal period, cuisine, dietary", () => {
  for (const [facet, keys] of Object.entries({
    dish_form: ["soup_dish", "dry_dish", "rolled", "porridge", "soup", "canh", "salad", "drink", "dessert"],
    carb_base: ["bun", "pho", "mi", "hu_tieu", "banh_canh", "com", "chao", "banh_mi", "banh_trang", "banh_hoi"],
    preparation: ["fry", "stir_fry", "grill", "steam", "boil", "braise", "stew", "roast", "pan_sear", "mix", "roll", "simmer_glaze", "mold_bake"],
    course: ["main", "side", "appetizer", "dessert", "drink"],
    meal_period: ["breakfast", "lunch", "afternoon", "dinner", "late_night", "snack"],
    cuisine: ["vietnamese", "chinese", "japanese", "korean"],
    dietary: ["vegetarian", "vegan"],
    lexical_family: ["banh"],
    dough_base: ["rice_flour", "wheat_flour", "tapioca_starch"],
  })) {
    for (const k of keys) assert.ok(t.hasFacetNode(facet, k), `${facet}/${k}`);
  }
  assert.deepEqual(t.facetDescendants("preparation", "fry").sort(), ["deep_fry", "fry"]);
});

test("TAXONOMY: taste, serving temperature and texture models", () => {
  for (const d of ["salty", "sweet", "sour", "spicy", "bitter", "umami", "rich", "aromatic", "light", "bold"]) {
    assert.equal(t.attribute(`taste.${d}`).type, "graded", d);
  }
  assert.deepEqual(Object.keys(t.attribute("temperature.serving").values), ["very_hot", "hot", "warm", "room", "cool", "cold", "iced", "either"]);
  for (const x of ["crispy", "soft", "chewy", "sticky", "crispy_outside_soft_inside", "soupy", "thick", "thin"]) assert.ok(t.attribute(`texture.${x}`), x);
  assert.ok(t.isValidAttributeValue("taste.spicy", { level: "adjustable" }));
  assert.ok(!t.isValidAttributeValue("taste.spicy", { value: "hot" }));
  assert.ok(t.isValidAttributeValue("temperature.serving", { value: "hot", level: null }));
  assert.ok(!t.isValidAttributeValue("temperature.serving", { value: "boiling" }));
  // serving temperature only — never an actual temperature, never a "tính" of the food
  assert.equal(t.attribute("temperature.actual"), null);
});

test("TAXONOMY: traditional-medicine 'tính nóng/mát' is an excluded concept", () => {
  assert.ok(t.isExcludedConcept("tcm_nature"));
  assert.ok(t.isExcludedConcept("tcm_nature.hot"));
  assert.ok(!t.isExcludedConcept("temperature.serving"));
});

test("TAXONOMY: ingredient tree — seafood groups, derived condiments", () => {
  assert.ok(t.ingredientIsA("protein.seafood.shrimp", "protein.seafood"));
  assert.ok(t.ingredientIsA("protein.seafood.shrimp", "protein.seafood.crustacean"));
  assert.ok(t.ingredientIsA("protein.seafood.squid", "protein.seafood.mollusk"));
  assert.ok(t.ingredientIsA("protein.seafood.fish_cake", "protein.seafood.fish"));
  assert.ok(!t.ingredientIsA("protein.beef", "protein.seafood"));
  // fish sauce is a condiment, NOT seafood — but its origin is recorded for "không hải sản" questions
  assert.ok(!t.ingredientIsA("condiment.fish_sauce", "protein.seafood"));
  assert.equal(t.ingredients.get("condiment.fish_sauce").derived_from, "protein.seafood.fish");
});

test("TAXONOMY: every source type has a tier; OSM requires the ODbL license", () => {
  for (const [id, st] of Object.entries(t.json.source_types)) assert.ok(st.tier > 0 && st.tier <= 1, id);
  assert.ok(t.sourceType("merchant_official").tier > t.sourceType("publication").tier);
  assert.ok(t.sourceType("publication").tier > t.sourceType("blog").tier);
  assert.equal(t.sourceType("osm").requires_license, "ODbL-1.0");
});

test("TAXONOMY: generic — no region or place names are baked into the classification", () => {
  const json = JSON.stringify(loadTaxonomyJson().facets) + JSON.stringify(loadTaxonomyJson().ingredients);
  assert.doesNotMatch(json, /nha trang|khánh hòa|khanh hoa/i);
});
