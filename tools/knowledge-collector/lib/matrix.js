import { DishFamilies } from "../../../platform/knowledge/dishFamily.js";
import { FoodTaxonomy } from "../../../platform/knowledge/taxonomy.js";
import { nfc, normalizeName, hasDiacritics } from "../../../platform/knowledge/text.js";

// Coverage MATRIX of the current discovered data: food family × merchants,
// cuisine, region (food origin/style — never merchant location), locality
// (as merchant addresses write it), food → merchant counts, review queues.
// Descriptive statistics only: never a ranking, never "best".

const LIVE = `SELECT id FROM kb_merchants WHERE status IN ('candidate', 'verified')`;
const lower = (s) => nfc(String(s ?? "")).toLowerCase();
// accent-sensitive for Vietnamese addresses; an address written without accents ("Loc Tho Ward") is compared unaccented
const wordIn = (hay, w) => {
  const [h, n] = hasDiacritics(hay) ? [hay, lower(w)] : [normalizeName(hay), normalizeName(w)];
  return new RegExp(`(?<![\\p{L}\\p{N}])${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, "u").test(h);
};

export function coverageMatrix(db, { region, taxonomy = new FoodTaxonomy() } = {}) {
  const rows = (sql, ...a) => db.prepare(sql).all(...a);
  const families = new DishFamilies(taxonomy);

  // --- food family: entities, and merchants that (per published links) serve a dish of the family
  const foods = rows(`SELECT id, canonical_name FROM kb_food_entities WHERE status = 'published'`);
  const merchantsOf = db.prepare(
    `SELECT DISTINCT p.merchant_id FROM kb_food_product_links l JOIN kb_merchant_products p ON p.id = l.kb_product_id WHERE l.food_entity_id = ? AND l.status = 'published' AND p.status = 'published' AND p.merchant_id IN (${LIVE})`
  );
  const family = {};
  for (const f of foods) {
    const k = families.familyOf(f.canonical_name) ?? "(no family word)";
    const e = (family[k] ??= { food_entities: 0, merchants: new Set() });
    e.food_entities += 1;
    for (const m of merchantsOf.all(f.id)) e.merchants.add(m.merchant_id);
  }
  const food_family = Object.fromEntries(Object.entries(family).sort((a, b) => b[1].food_entities - a[1].food_entities).map(([k, v]) => [k, { food_entities: v.food_entities, merchants_with_linked_dish: v.merchants.size }]));

  // --- cuisine: foods (published facet) and merchants (tag from their own listing heading)
  const cuisine = {};
  for (const r of rows(`SELECT value, COUNT(DISTINCT entity_id) AS n FROM kb_claims WHERE kind = 'facet' AND key IN ('cuisine', 'dietary') AND status = 'published' AND entity_id IN (SELECT id FROM kb_food_entities WHERE status = 'published') GROUP BY value`)) (cuisine[r.value] ??= {}).food_entities = r.n;
  for (const r of rows(`SELECT json_extract(value_json, '$.key') AS k, COUNT(DISTINCT merchant_id) AS n FROM kb_merchant_claims WHERE field = 'cuisine' AND status = 'published' AND merchant_id IN (${LIVE}) GROUP BY k`)) (cuisine[r.k] ??= {}).merchants = r.n;

  // --- region: a DISH's specialty / origin / style
  const regionRows = rows(
    `SELECT c.key, c.value, r.name, COUNT(DISTINCT c.entity_id) AS n FROM kb_claims c JOIN kb_regions r ON r.id = c.value
     WHERE c.kind = 'relation' AND c.key IN ('regional_specialty', 'origin_region', 'regional_style') AND c.status IN ('published', 'review')
       AND c.entity_id IN (SELECT id FROM kb_food_entities WHERE status = 'published') GROUP BY c.key, c.value, c.status`
  );
  const food_region = {};
  for (const r of regionRows) ((food_region[r.name] ??= {})[r.key] = (food_region[r.name]?.[r.key] ?? 0) + r.n);

  // --- locality as each merchant's address text names it
  const wards = region?.wards ?? [];
  const nearby = region?.nearby ?? [];
  const locality = { by_ward: {}, nearby: {}, nha_trang_no_ward: 0, no_locality_in_address: 0 };
  for (const m of rows(`SELECT m.id, (SELECT group_concat(address_original, ' | ') FROM kb_merchant_locations l WHERE l.merchant_id = m.id AND l.status = 'published') AS addr FROM kb_merchants m WHERE m.id IN (${LIVE})`)) {
    const a = lower(m.addr);
    const ward = wards.find((w) => wordIn(a, w));
    const near = nearby.find((w) => wordIn(a, w));
    if (near && !ward) locality.nearby[near] = (locality.nearby[near] ?? 0) + 1;
    else if (ward) locality.by_ward[ward] = (locality.by_ward[ward] ?? 0) + 1;
    else if (wordIn(a, "nha trang")) locality.nha_trang_no_ward += 1;
    else locality.no_locality_in_address += 1;
  }
  locality.by_ward = Object.fromEntries(Object.entries(locality.by_ward).sort((x, y) => y[1] - x[1]));

  // --- food -> merchants / products / evidence
  const food_merchant = rows(
    `SELECT f.canonical_name AS food, COUNT(DISTINCT p.merchant_id) AS merchant_count, COUNT(DISTINCT p.id) AS product_count, COUNT(DISTINCT e.source_id) AS evidence_sources
     FROM kb_food_product_links l JOIN kb_food_entities f ON f.id = l.food_entity_id JOIN kb_merchant_products p ON p.id = l.kb_product_id LEFT JOIN kb_evidence e ON e.id = p.evidence_id
     WHERE l.status = 'published' AND p.status = 'published' AND f.status = 'published' AND p.merchant_id IN (${LIVE})
     GROUP BY f.id ORDER BY merchant_count DESC, food LIMIT 40`
  );

  // --- review queues (each row carries its reason + evidence in its table)
  const n = (sql) => db.prepare(sql).get().n;
  const review_queues = {
    food_review: n(`SELECT COUNT(*) AS n FROM kb_food_entities WHERE status = 'review'`),
    food_name_review: n(`SELECT COUNT(*) AS n FROM kb_food_names WHERE status = 'review'`),
    food_duplicate_review: n(`SELECT COUNT(*) AS n FROM kb_food_duplicate_candidates WHERE status = 'pending'`),
    merchant_review: n(`SELECT COUNT(*) AS n FROM kb_merchant_claims WHERE status = 'review'`) + n(`SELECT COUNT(*) AS n FROM kb_merchant_locations WHERE status = 'review'`),
    merchant_duplicate_review: n(`SELECT COUNT(*) AS n FROM kb_duplicate_candidates WHERE status = 'pending'`),
    product_review: n(`SELECT COUNT(*) AS n FROM kb_merchant_products WHERE status = 'review'`),
    food_merchant_link_review: n(`SELECT COUNT(*) AS n FROM kb_food_product_links WHERE status = 'review'`),
    semantic_claim_review: n(`SELECT COUNT(*) AS n FROM kb_claims WHERE status = 'review' AND entity_id IN (SELECT id FROM kb_food_entities WHERE status IN ('published', 'review'))`),
    price_review: n(`SELECT COUNT(*) AS n FROM kb_product_prices WHERE status = 'review'`),
    source_conflicts: n(`SELECT COUNT(*) AS n FROM kb_source_conflicts WHERE status = 'open'`),
  };
  return { label: "coverage matrix of the current discovered data — descriptive counts only, not a ranking", food_family, cuisine, food_region, merchant_locality: locality, food_merchant, review_queues };
}
