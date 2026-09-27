import { DishFamilies } from "../../../platform/knowledge/dishFamily.js";
import { FoodTaxonomy } from "../../../platform/knowledge/taxonomy.js";
import { addressKey } from "../../../platform/knowledge/discoveryStore.js";

// "Current discovered Food Knowledge coverage": what the knowledge.db holds
// NOW, from the sources collected so far. Counts are coverage statistics
// only — not popularity, quality or a ranking, and not "all of Nha Trang".

export function coverageReport(db, { taxonomy = new FoodTaxonomy(), crawl = null, quality = null } = {}) {
  const n = (sql, ...a) => db.prepare(sql).get(...a).n;
  const rows = (sql, ...a) => db.prepare(sql).all(...a);
  const byStatus = (table, where = "1=1") => Object.fromEntries(rows(`SELECT status, COUNT(*) AS n FROM ${table} WHERE ${where} GROUP BY status`).map((r) => [r.status, r.n]));
  const families = new DishFamilies(taxonomy);
  const LIVE = `SELECT id FROM kb_merchants WHERE status IN ('candidate', 'verified')`;

  // --- foods
  const entities = rows(`SELECT id, key, canonical_name, status FROM kb_food_entities WHERE status IN ('published', 'review')`);
  const familyCounts = {};
  for (const e of entities.filter((x) => x.status === "published")) {
    const f = families.familyOf(e.canonical_name) ?? "(none)";
    familyCounts[f] = (familyCounts[f] ?? 0) + 1;
  }
  // claims of published / in-review foods only (a retired or rejected food's claims say nothing)
  const claimKinds = rows(`SELECT kind, key, status, COUNT(*) AS n FROM kb_claims WHERE entity_id IN (SELECT id FROM kb_food_entities WHERE status IN ('published', 'review')) GROUP BY kind, key, status`);
  const sumClaims = (pred) => claimKinds.filter(pred).reduce((acc, r) => ({ ...acc, [r.status]: (acc[r.status] ?? 0) + r.n }), {});
  const foodsWith = (kindSql) => n(`SELECT COUNT(DISTINCT entity_id) AS n FROM kb_claims WHERE status = 'published' AND entity_id IN (SELECT id FROM kb_food_entities WHERE status = 'published') AND ${kindSql}`);

  // --- merchants (discovery candidates; not verified businesses)
  const merchants = rows(`SELECT id, name, normalized_name FROM kb_merchants WHERE status IN ('candidate', 'verified')`);
  const pendingDup = rows(`SELECT merchant_a, merchant_b, signals_json, score FROM kb_duplicate_candidates WHERE status = 'pending'`);
  // if every pending same-name + same-address candidate were confirmed, how many places would remain
  const parent = new Map(merchants.map((m) => [m.id, m.id]));
  const find = (x) => (parent.get(x) === x ? x : find(parent.get(x)));
  for (const d of pendingDup) if (JSON.parse(d.signals_json).same_address) parent.set(find(d.merchant_a), find(d.merchant_b));
  const clusters = new Set(merchants.map((m) => find(m.id))).size;

  const topFoods = rows(
    `SELECT f.key, f.canonical_name AS name, COUNT(DISTINCT p.merchant_id) AS merchants, COUNT(DISTINCT e.source_id) AS sources
     FROM kb_food_product_links l
     JOIN kb_food_entities f ON f.id = l.food_entity_id
     JOIN kb_merchant_products p ON p.id = l.kb_product_id
     JOIN kb_merchants m ON m.id = p.merchant_id AND m.status IN ('candidate', 'verified')
     LEFT JOIN kb_evidence e ON e.id = p.evidence_id
     WHERE l.status = 'published' AND p.status = 'published'
     GROUP BY f.id ORDER BY merchants DESC, f.canonical_name LIMIT 25`
  );

  return {
    label: "current discovered Food Knowledge coverage for Nha Trang (from the sources collected so far; not exhaustive)",
    foods: {
      entities: byStatus("kb_food_entities"),
      names: byStatus("kb_food_names"),
      aliases_published: n(`SELECT COUNT(*) AS n FROM kb_food_names WHERE status = 'published' AND kind NOT IN ('canonical', 'no_accent')`),
      by_lexical_family: familyCounts,
      entities_from_mentions_in_review: n(`SELECT COUNT(DISTINCT n.entity_id) AS n FROM kb_food_names n JOIN kb_evidence e ON e.id = n.evidence_id JOIN kb_food_entities f ON f.id = n.entity_id WHERE n.kind = 'canonical' AND f.status = 'review' AND e.proposed_by = 'collector:listicle-mention'`),
      duplicate_or_variant_candidates: Object.fromEntries(rows(`SELECT kind, COUNT(*) AS n FROM kb_food_duplicate_candidates WHERE status = 'pending' GROUP BY kind`).map((r) => [r.kind, r.n])),
    },
    semantic: {
      claims_by_status: byStatus("kb_claims", "entity_id IN (SELECT id FROM kb_food_entities WHERE status IN ('published', 'review'))"),
      facets: sumClaims((r) => r.kind === "facet"),
      ingredients: sumClaims((r) => r.kind === "ingredient"),
      sensory_attributes: sumClaims((r) => r.kind === "attribute"),
      foods_with_published_facet: foodsWith(`kind = 'facet'`),
      foods_with_published_ingredient: foodsWith(`kind = 'ingredient'`),
      foods_with_published_attribute: foodsWith(`kind = 'attribute'`),
      foods_with_any_published_fact: foodsWith(`kind IN ('facet', 'ingredient', 'attribute')`),
      foods_by_published_cuisine: Object.fromEntries(rows(`SELECT value, COUNT(DISTINCT entity_id) AS n FROM kb_claims WHERE kind = 'facet' AND key = 'cuisine' AND status = 'published' AND entity_id IN (SELECT id FROM kb_food_entities WHERE status = 'published') GROUP BY value`).map((r) => [r.value, r.n])),
    },
    origin_style: {
      note: "food origin / style / specialty — never where a merchant is",
      regional_specialty: sumClaims((r) => r.kind === "relation" && r.key === "regional_specialty"),
      origin_region: sumClaims((r) => r.kind === "relation" && r.key === "origin_region"),
      regional_style: sumClaims((r) => r.kind === "relation" && r.key === "regional_style"),
      regions_registered: n(`SELECT COUNT(*) AS n FROM kb_regions`),
    },
    merchants: {
      note: "discovery candidates found in sources — not verified, not orderable unless bridged by a person",
      candidates: merchants.length,
      distinct_if_same_address_candidates_confirmed: clusters,
      duplicate_candidates_pending: pendingDup.length,
      duplicate_candidates_same_address: pendingDup.filter((d) => JSON.parse(d.signals_json).same_address).length,
      // same name + same written address on two DIFFERENT sites: independent corroboration (still two rows until a person merges)
      corroborated_pairs_2plus_domains: pendingDup.filter((d) => {
        if (!JSON.parse(d.signals_json).same_address) return false;
        const dom = (id) => db.prepare(`SELECT s.domain FROM kb_merchant_claims c JOIN kb_evidence e ON e.id = c.evidence_id JOIN kb_sources s ON s.id = e.source_id WHERE c.merchant_id = ? AND c.field = 'name' LIMIT 1`).get(id)?.domain;
        return dom(d.merchant_a) !== dom(d.merchant_b);
      }).length,
      with_address: n(`SELECT COUNT(DISTINCT merchant_id) AS n FROM kb_merchant_locations WHERE status = 'published' AND merchant_id IN (${LIVE}) AND address_original != ''`),
      with_house_number_address: new Set(rows(`SELECT merchant_id, address_original FROM kb_merchant_locations WHERE status = 'published' AND merchant_id IN (${LIVE})`).filter((r) => addressKey(r.address_original)).map((r) => r.merchant_id)).size,
      with_coordinates: n(`SELECT COUNT(DISTINCT merchant_id) AS n FROM kb_merchant_locations WHERE status = 'published' AND merchant_id IN (${LIVE}) AND latitude IS NOT NULL`),
      in_nha_trang_region: n(`SELECT COUNT(DISTINCT merchant_id) AS n FROM kb_merchant_locations WHERE status = 'published' AND merchant_id IN (${LIVE}) AND region_id = 'vn.khanh-hoa.nha-trang'`),
      with_opening_hours_text: n(`SELECT COUNT(DISTINCT merchant_id) AS n FROM kb_merchant_claims WHERE status = 'published' AND merchant_id IN (${LIVE}) AND field = 'opening_hours'`),
      with_structured_opening_hours: n(`SELECT COUNT(DISTINCT merchant_id) AS n FROM kb_merchant_claims WHERE status = 'published' AND merchant_id IN (${LIVE}) AND field = 'opening_hours' AND value_json IS NOT NULL`),
      by_cuisine_tag: Object.fromEntries(rows(`SELECT json_extract(value_json, '$.key') AS k, COUNT(DISTINCT merchant_id) AS n FROM kb_merchant_claims WHERE status = 'published' AND field = 'cuisine' AND merchant_id IN (${LIVE}) GROUP BY k`).map((r) => [r.k, r.n])),
      with_phone: n(`SELECT COUNT(DISTINCT merchant_id) AS n FROM kb_merchant_claims WHERE status = 'published' AND merchant_id IN (${LIVE}) AND field = 'phone'`),
      with_rating: n(`SELECT COUNT(DISTINCT merchant_id) AS n FROM kb_merchant_ratings WHERE status = 'published' AND merchant_id IN (${LIVE})`),
      with_menu: n(`SELECT COUNT(DISTINCT merchant_id) AS n FROM kb_merchant_products WHERE status = 'published' AND merchant_id IN (${LIVE}) AND observation = 'menu'`),
      with_dish_mention: n(`SELECT COUNT(DISTINCT merchant_id) AS n FROM kb_merchant_products WHERE status = 'published' AND merchant_id IN (${LIVE}) AND observation = 'mention'`),
      with_linked_food: n(`SELECT COUNT(DISTINCT p.merchant_id) AS n FROM kb_food_product_links l JOIN kb_merchant_products p ON p.id = l.kb_product_id WHERE l.status = 'published' AND p.status = 'published' AND p.merchant_id IN (${LIVE})`),
      listings_in_2plus_sources_note: "each article listing is its own candidate until a person merges duplicates",
      seen_in_2plus_sources: n(`SELECT COUNT(*) AS n FROM (SELECT c.merchant_id FROM kb_merchant_claims c JOIN kb_evidence e ON e.id = c.evidence_id JOIN kb_sources s ON s.id = e.source_id WHERE c.field = 'name' AND c.status = 'published' GROUP BY c.merchant_id HAVING COUNT(DISTINCT s.url) >= 2)`),
      bridged_to_platform: n(`SELECT COUNT(*) AS n FROM kb_merchant_links`),
    },
    products: {
      by_observation_and_status: Object.fromEntries(rows(`SELECT observation || ':' || status AS k, COUNT(*) AS n FROM kb_merchant_products GROUP BY k`).map((r) => [r.k, r.n])),
      prices_published: n(`SELECT COUNT(*) AS n FROM kb_product_prices WHERE status = 'published'`),
      products_with_price: n(`SELECT COUNT(DISTINCT product_id) AS n FROM kb_product_prices WHERE status = 'published' AND price IS NOT NULL`),
    },
    food_merchant_links: {
      links: byStatus("kb_food_product_links"),
      foods_with_merchant: n(`SELECT COUNT(DISTINCT l.food_entity_id) AS n FROM kb_food_product_links l JOIN kb_merchant_products p ON p.id = l.kb_product_id WHERE l.status = 'published' AND p.status = 'published' AND p.merchant_id IN (${LIVE})`),
      foods_published_without_merchant: n(`SELECT COUNT(*) AS n FROM kb_food_entities f WHERE f.status = 'published' AND NOT EXISTS (SELECT 1 FROM kb_food_product_links l WHERE l.food_entity_id = f.id AND l.status = 'published')`),
      top_foods_by_merchant_count: { note: "coverage statistic only — how many discovered places a source says serve the dish; NOT popularity, quality or 'best'", rows: topFoods },
    },
    sources: {
      by_type: Object.fromEntries(rows(`SELECT source_type, COUNT(*) AS n FROM kb_sources GROUP BY source_type`).map((r) => [r.source_type, r.n])),
      by_domain: Object.fromEntries(rows(`SELECT domain, COUNT(*) AS n FROM kb_sources GROUP BY domain ORDER BY n DESC`).map((r) => [r.domain, r.n])),
      open_conflicts: n(`SELECT COUNT(*) AS n FROM kb_source_conflicts WHERE status = 'open'`),
      by_quality_tier: Object.fromEntries(
        Object.entries(
          rows(`SELECT source_type, COUNT(*) AS n FROM kb_sources GROUP BY source_type`).reduce((acc, r) => {
            const tier = `tier_${taxonomy.sourceType(r.source_type)?.quality_tier ?? 5}`;
            acc[tier] = (acc[tier] ?? 0) + r.n;
            return acc;
          }, {})
        ).sort()
      ),
      fetches: crawl ?? "no crawl log given",
    },
    menu: {
      merchants_with_own_menu: n(`SELECT COUNT(DISTINCT merchant_id) AS n FROM kb_merchant_products WHERE status = 'published' AND observation = 'menu' AND merchant_id IN (${LIVE})`),
      menu_products: n(`SELECT COUNT(*) AS n FROM kb_merchant_products WHERE status = 'published' AND observation = 'menu' AND merchant_id IN (${LIVE})`),
      article_reported_products: n(`SELECT COUNT(*) AS n FROM kb_merchant_products WHERE status = 'published' AND observation = 'mention' AND merchant_id IN (${LIVE})`),
      products_with_price: n(`SELECT COUNT(DISTINCT x.product_id) AS n FROM kb_product_prices x JOIN kb_merchant_products p ON p.id = x.product_id WHERE x.status = 'published' AND x.price IS NOT NULL AND p.status = 'published' AND p.merchant_id IN (${LIVE})`),
      products_without_price: n(`SELECT COUNT(*) AS n FROM kb_merchant_products p WHERE p.status = 'published' AND p.merchant_id IN (${LIVE}) AND NOT EXISTS (SELECT 1 FROM kb_product_prices x WHERE x.product_id = p.id AND x.status = 'published')`),
      menu_categories: n(`SELECT COUNT(*) AS n FROM kb_menu_categories`),
      products_linked_to_food: n(`SELECT COUNT(DISTINCT kb_product_id) AS n FROM kb_food_product_links WHERE status = 'published'`),
    },
    prices: {
      observations: n(`SELECT COUNT(*) AS n FROM kb_product_prices WHERE status = 'published'`),
      by_source_type: Object.fromEntries(rows(`SELECT s.source_type, COUNT(*) AS n FROM kb_product_prices x JOIN kb_evidence e ON e.id = x.evidence_id JOIN kb_sources s ON s.id = e.source_id WHERE x.status = 'published' GROUP BY s.source_type`).map((r) => [r.source_type, r.n])),
      products_with_price_history: n(`SELECT COUNT(*) AS n FROM (SELECT product_id FROM kb_product_prices WHERE status = 'published' GROUP BY product_id, variant HAVING COUNT(*) > 1)`),
      conflicts: n(`SELECT COUNT(*) AS n FROM kb_source_conflicts WHERE subject_type = 'price'`),
      note: "each price belongs to one merchant product and one observation date; there is no single 'price of a dish'",
    },
    semantics_detail: {
      ingredient: foodsCovered(`kind = 'ingredient'`),
      taste: foodsCovered(`kind = 'attribute' AND key LIKE 'taste.%'`),
      texture: foodsCovered(`kind = 'attribute' AND key LIKE 'texture.%'`),
      temperature: foodsCovered(`kind = 'attribute' AND key = 'temperature.serving'`),
      cuisine: foodsCovered(`kind = 'facet' AND key = 'cuisine'`),
      dietary: foodsCovered(`kind = 'facet' AND key = 'dietary'`),
      preparation: foodsCovered(`kind = 'facet' AND key = 'preparation'`),
      meal_period: foodsCovered(`kind = 'facet' AND key = 'meal_period'`),
      regional_style: foodsCovered(`kind = 'relation' AND key = 'regional_style'`),
      origin_region: foodsCovered(`kind = 'relation' AND key = 'origin_region'`),
      variant_relations_pending: n(`SELECT COUNT(*) AS n FROM kb_food_duplicate_candidates WHERE status = 'pending' AND kind IN ('regional_style_of', 'name_extends')`),
    },
    quality: quality ?? "no quality sample recorded (run: cli.js sample)",
  };

  function foodsCovered(where) {
    const ent = `entity_id IN (SELECT id FROM kb_food_entities WHERE status = 'published')`;
    return {
      foods_published: n(`SELECT COUNT(DISTINCT entity_id) AS n FROM kb_claims WHERE status = 'published' AND ${ent} AND ${where}`),
      foods_in_review: n(`SELECT COUNT(DISTINCT entity_id) AS n FROM kb_claims WHERE status = 'review' AND ${ent} AND ${where}`),
    };
  }
}

/** Fetch outcomes from the raw store's crawl log (one line per request). */
export function crawlLogStats(logFile, fs) {
  if (!fs.existsSync(logFile)) return null;
  const out = { requests: 0, stored: 0, by_block_reason: {} };
  for (const line of fs.readFileSync(logFile, "utf8").split("\n")) {
    if (!line) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    out.requests += 1;
    if (e.stored) out.stored += 1;
    if (e.blocked) out.by_block_reason[e.blocked] = (out.by_block_reason[e.blocked] ?? 0) + 1;
  }
  return out;
}
