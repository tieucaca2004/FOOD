import fs from "node:fs";

// FoodTaxonomy: the reviewed, generic classification the knowledge layer
// validates every claim against (lexicon/taxonomy.json). Nothing here is
// region- or dish-specific; Nha Trang is data, not code.

const TAXONOMY_URL = new URL("./lexicon/taxonomy.json", import.meta.url);

export function loadTaxonomyJson() {
  return JSON.parse(fs.readFileSync(TAXONOMY_URL, "utf8"));
}

/** Structural problems of a taxonomy document (empty = valid). */
export function validateTaxonomy(t) {
  const problems = [];
  const need = ["levels", "scopes", "source_types", "extraction_adjustments", "facets", "attributes", "ingredients", "ingredient_roles", "relations", "excluded_concepts"];
  for (const k of need) if (!t[k]) problems.push(`missing section "${k}"`);
  if (problems.length) return problems;

  for (const [facetId, facet] of Object.entries(t.facets)) {
    const keys = new Set();
    for (const node of facet.nodes) {
      if (keys.has(node.key)) problems.push(`facet ${facetId}: duplicate node "${node.key}"`);
      keys.add(node.key);
      if (!node.label_vi) problems.push(`facet ${facetId}: node "${node.key}" has no label_vi`);
    }
    for (const node of facet.nodes) {
      if (node.parent && !keys.has(node.parent)) problems.push(`facet ${facetId}: node "${node.key}" has unknown parent "${node.parent}"`);
    }
    problems.push(...cycles(facet.nodes, `facet ${facetId}`));
  }

  const ingredientKeys = new Set();
  for (const ing of t.ingredients) {
    if (ingredientKeys.has(ing.key)) problems.push(`ingredient: duplicate "${ing.key}"`);
    ingredientKeys.add(ing.key);
  }
  for (const ing of t.ingredients) {
    if (ing.parent && !ingredientKeys.has(ing.parent)) problems.push(`ingredient "${ing.key}": unknown parent "${ing.parent}"`);
    if (ing.derived_from && !ingredientKeys.has(ing.derived_from)) problems.push(`ingredient "${ing.key}": unknown derived_from "${ing.derived_from}"`);
  }
  problems.push(...cycles(t.ingredients, "ingredients"));

  for (const [id, attr] of Object.entries(t.attributes)) {
    if (!["graded", "enum"].includes(attr.type)) problems.push(`attribute ${id}: type must be graded|enum`);
    if (attr.type === "enum" && !Object.keys(attr.values || {}).length) problems.push(`attribute ${id}: enum without values`);
  }
  for (const [id, st] of Object.entries(t.source_types)) {
    if (!(st.tier > 0 && st.tier <= 1)) problems.push(`source type ${id}: tier must be in (0, 1]`);
  }
  return problems;
}

function cycles(nodes, where) {
  const parent = new Map(nodes.map((n) => [n.key, n.parent]));
  const problems = [];
  for (const n of nodes) {
    const seen = new Set();
    for (let k = n.key; k; k = parent.get(k)) {
      if (seen.has(k)) {
        problems.push(`${where}: cycle through "${n.key}"`);
        break;
      }
      seen.add(k);
    }
  }
  return problems;
}

export class FoodTaxonomy {
  constructor(json = loadTaxonomyJson()) {
    const problems = validateTaxonomy(json);
    if (problems.length) throw new Error(`invalid taxonomy: ${problems.join("; ")}`);
    this.json = json;
    this.levels = new Set(json.levels);
    this.scopes = new Set(json.scopes);
    this.ingredients = new Map(json.ingredients.map((i) => [i.key, i]));
    this.facetNodes = new Map(Object.entries(json.facets).map(([id, f]) => [id, new Map(f.nodes.map((n) => [n.key, n]))]));
  }

  hasFacetNode(facetId, key) {
    return Boolean(this.facetNodes.get(facetId)?.has(key));
  }

  attribute(id) {
    return this.json.attributes[id] || null;
  }

  isValidAttributeValue(id, { value, level }) {
    const attr = this.attribute(id);
    if (!attr) return false;
    if (attr.type === "enum") return value in attr.values && (level === null || level === undefined);
    return this.levels.has(level) && (value === null || value === undefined);
  }

  hasIngredient(key) {
    return this.ingredients.has(key);
  }

  /** "protein.seafood.shrimp" isA "protein.seafood" (and itself). */
  ingredientIsA(key, ancestor) {
    for (let k = key; k; k = this.ingredients.get(k)?.parent) if (k === ancestor) return true;
    return false;
  }

  /** Every node of the facet at or under `key` (e.g. preparation "fry" -> fry, deep_fry). */
  facetDescendants(facetId, key) {
    const nodes = this.facetNodes.get(facetId);
    if (!nodes) return [];
    const isUnder = (k) => {
      for (let cur = k; cur; cur = nodes.get(cur)?.parent) if (cur === key) return true;
      return false;
    };
    return [...nodes.keys()].filter(isUnder);
  }

  sourceType(id) {
    return this.json.source_types[id] || null;
  }

  relation(id) {
    return this.json.relations[id] || null;
  }

  isExcludedConcept(key) {
    return this.json.excluded_concepts.some((c) => c.key === key || String(key).startsWith(`${c.key}.`));
  }
}
