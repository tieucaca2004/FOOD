import { normalizeName } from "../../../platform/knowledge/text.js";

// Proposes food ↔ merchant-product links from names. Only an EXACT name
// equality is proposed as "exact" (and the store re-checks it); a product
// name that contains a dish name ("Bún cá đặc biệt" ⊃ "bún cá") is only a
// "variant" candidate for review; several dishes inside one name ("bún cá
// sứa") are all proposed for review — never chosen.

function containsPhrase(haystack, needle) {
  return ` ${haystack} `.includes(` ${needle} `);
}

/**
 * @param {Array<{id, normalized_name}>} products published reference products
 * @param {Array<{key, names: string[]}>} foods published food entities with their published normalized names
 * @returns {Array<{kbProductId, foodKey, matchType}>}
 */
export function planLinks(products, foods) {
  const plan = [];
  for (const p of products) {
    const exact = foods.filter((f) => f.names.includes(p.normalized_name));
    if (exact.length === 1) {
      plan.push({ kbProductId: p.id, foodKey: exact[0].key, matchType: "exact" });
      continue;
    }
    const contained = foods
      .map((f) => ({ f, name: f.names.filter((n) => n && containsPhrase(p.normalized_name, n)).sort((a, b) => b.length - a.length)[0] }))
      .filter((x) => x.name);
    // a shorter dish name inside a longer matched one ("bun" inside "bun cha ca") adds nothing
    const kept = contained.filter((x) => !contained.some((y) => y !== x && y.name.length > x.name.length && containsPhrase(y.name, x.name)));
    for (const x of kept) plan.push({ kbProductId: p.id, foodKey: x.f.key, matchType: "variant" });
  }
  return plan;
}

export function linkAll({ knowledge, discovery }) {
  const db = knowledge.db;
  const products = db.prepare(`SELECT id, normalized_name FROM kb_merchant_products WHERE status = 'published'`).all();
  const foods = db
    .prepare(`SELECT e.key, n.normalized FROM kb_food_entities e JOIN kb_food_names n ON n.entity_id = e.id AND n.status = 'published' WHERE e.status = 'published'`)
    .all()
    .reduce((acc, r) => {
      (acc.get(r.key) ?? acc.set(r.key, []).get(r.key)).push(normalizeName(r.normalized));
      return acc;
    }, new Map());
  const plan = planLinks(products, [...foods].map(([key, names]) => ({ key, names })));
  const counts = { exact: 0, variant: 0, published: 0, review: 0 };
  for (const step of plan) {
    const r = discovery.proposeFoodProductLink(step);
    counts[step.matchType] += 1;
    counts[r.outcome] = (counts[r.outcome] ?? 0) + 1;
  }
  return counts;
}
