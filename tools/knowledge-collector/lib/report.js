import { isStale } from "../../../platform/knowledge/freshness.js";

// Data-quality report over a knowledge.db (published data unless noted).
export function dataQualityReport(db, { now = new Date() } = {}) {
  const one = (sql, ...a) => db.prepare(sql).get(...a).n;
  const staleCount = (sql, kind) => db.prepare(sql).all().filter((r) => isStale(kind, r.last_seen_at, now)).length;
  return {
    merchant_count: one(`SELECT COUNT(*) AS n FROM kb_merchants WHERE status IN ('candidate','verified')`),
    food_entity_count: one(`SELECT COUNT(*) AS n FROM kb_food_entities WHERE status = 'published'`),
    product_count: one(`SELECT COUNT(*) AS n FROM kb_merchant_products WHERE status = 'published'`),
    menu_count: one(`SELECT COUNT(*) AS n FROM kb_menus`),
    price_count: one(`SELECT COUNT(*) AS n FROM kb_product_prices WHERE status = 'published'`),
    rating_count: one(`SELECT COUNT(*) AS n FROM kb_merchant_ratings WHERE status = 'published' AND rating IS NOT NULL`),
    review_count: one(`SELECT COUNT(*) AS n FROM kb_merchant_ratings WHERE status = 'published' AND review_count IS NOT NULL`),
    source_count: one(`SELECT COUNT(*) AS n FROM kb_sources`),
    duplicate_candidates: one(`SELECT COUNT(*) AS n FROM kb_duplicate_candidates WHERE status = 'pending'`),
    source_conflicts: one(`SELECT COUNT(*) AS n FROM kb_source_conflicts WHERE status = 'open'`),
    products_without_food_link: one(
      `SELECT COUNT(*) AS n FROM kb_merchant_products p WHERE p.status = 'published'
       AND NOT EXISTS (SELECT 1 FROM kb_food_product_links l WHERE l.kb_product_id = p.id AND l.status = 'published')`
    ),
    foods_without_merchant_link: one(
      `SELECT COUNT(*) AS n FROM kb_food_entities f WHERE f.status = 'published'
       AND NOT EXISTS (SELECT 1 FROM kb_food_product_links l WHERE l.food_entity_id = f.id AND l.status = 'published')`
    ),
    attributes_without_evidence: one(
      `SELECT COUNT(*) AS n FROM kb_claims c LEFT JOIN kb_evidence e ON e.id = c.evidence_id
       WHERE c.status = 'published' AND (e.id IS NULL OR e.verification != 'verified')`
    ),
    stale_records:
      staleCount(`SELECT last_seen_at FROM kb_product_prices WHERE status = 'published'`, "price") +
      staleCount(`SELECT last_seen_at FROM kb_merchant_ratings WHERE status = 'published'`, "rating") +
      staleCount(`SELECT last_seen_at FROM kb_merchant_claims WHERE status = 'published' AND field = 'opening_hours'`, "opening_hours"),
    missing_location: one(
      `SELECT COUNT(*) AS n FROM kb_merchants m WHERE m.status IN ('candidate','verified')
       AND NOT EXISTS (SELECT 1 FROM kb_merchant_locations l WHERE l.merchant_id = m.id AND l.status = 'published')`
    ),
    missing_price: one(
      `SELECT COUNT(*) AS n FROM kb_merchant_products p WHERE p.status = 'published'
       AND NOT EXISTS (SELECT 1 FROM kb_product_prices x WHERE x.product_id = p.id AND x.status = 'published')`
    ),
    // extra detail
    food_claims_published: one(`SELECT COUNT(*) AS n FROM kb_claims WHERE status = 'published'`),
    food_claims_in_review: one(`SELECT COUNT(*) AS n FROM kb_claims WHERE status = 'review'`),
    food_claims_rejected: one(`SELECT COUNT(*) AS n FROM kb_claims WHERE status = 'rejected'`),
    links_published: one(`SELECT COUNT(*) AS n FROM kb_food_product_links WHERE status = 'published'`),
    links_in_review: one(`SELECT COUNT(*) AS n FROM kb_food_product_links WHERE status = 'review'`),
    merchants_with_coordinates: one(`SELECT COUNT(DISTINCT merchant_id) AS n FROM kb_merchant_locations WHERE status = 'published' AND latitude IS NOT NULL`),
    merchants_with_opening_hours: one(`SELECT COUNT(DISTINCT merchant_id) AS n FROM kb_merchant_claims WHERE status = 'published' AND field = 'opening_hours'`),
    merchants_with_cuisine: one(`SELECT COUNT(DISTINCT merchant_id) AS n FROM kb_merchant_claims WHERE status = 'published' AND field = 'cuisine'`),
    merchants_with_menu: one(`SELECT COUNT(DISTINCT merchant_id) AS n FROM kb_merchant_products WHERE status = 'published'`),
  };
}
