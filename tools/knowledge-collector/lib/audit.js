import { normalizeName } from "../../../platform/knowledge/text.js";
import { isNotADish, isCookingMethod, NOT_A_DISH_TITLE, canonicalNamesOf } from "../sources/wikipedia.js";
import { proposalsFromSentence, variantProposals } from "../extract/foodFacts.js";
import fs from "node:fs";
import { addressKey } from "../../../platform/knowledge/discoveryStore.js";
import { parsePrice } from "../../../platform/knowledge/price.js";
import path from "node:path";
import { isGenericPlaceName, isDishText, listicleSections, isFoodPlaceSection, placeNameFromHeading } from "../sources/listicle.js";

// Data-quality audit of a knowledge.db. Every check lists the offending rows;
// with fix = true the rows a check can safely judge are MARKED (status
// rejected / retired, reason "AUDIT:<code>") — nothing is ever deleted, and
// checks that need a person (duplicates, conflicts) only report.

const LIVE = `SELECT id FROM kb_merchants WHERE status IN ('candidate', 'verified')`;
const CAPTION = /(?:^|\s)(?:Ảnh|Nguồn ảnh|Hình ảnh|Hình|Photo|Nguồn)\s*:/u;
const MAX_PLAUSIBLE_VND = 50_000_000;

export function auditKnowledge({ db, knowledge, fix = false, show = 8, policy = null }) {
  const rows = (sql, ...a) => db.prepare(sql).all(...a);
  const checks = {};
  const add = (code, items, action = null) => {
    checks[code] = { count: items.length, fixed: 0, sample: items.slice(0, show).map((i) => i.label) };
    if (fix && action) for (const i of items) checks[code].fixed += action(i) ? 1 : 0;
  };
  const rejectEntity = (id, code) => {
    db.prepare(`UPDATE kb_food_entities SET status = 'rejected', updated_at = datetime('now') WHERE id = ? AND status IN ('published', 'review')`).run(id);
    db.prepare(`UPDATE kb_food_names SET status = 'rejected', review_reason = ? WHERE entity_id = ? AND status != 'rejected'`).run(`AUDIT:${code}`, id);
    db.prepare(`UPDATE kb_food_product_links SET status = 'rejected', review_reason = ?, updated_at = datetime('now') WHERE food_entity_id = ? AND status != 'rejected'`).run(`AUDIT:${code}`, id);
    return true;
  };
  const rejectProduct = (id, code) => {
    const n = db.prepare(`UPDATE kb_merchant_products SET status = 'rejected' WHERE id = ? AND status != 'rejected'`).run(id).changes;
    db.prepare(`UPDATE kb_food_product_links SET status = 'rejected', review_reason = ?, updated_at = datetime('now') WHERE kb_product_id = ? AND status != 'rejected'`).run(`AUDIT:${code}`, id);
    db.prepare(`UPDATE kb_product_prices SET status = 'rejected' WHERE product_id = ? AND status != 'rejected'`).run(id);
    return n > 0;
  };
  const rejectMerchant = (id, code) => {
    const n = db.prepare(`UPDATE kb_merchants SET status = 'rejected', updated_at = datetime('now') WHERE id = ? AND status = 'candidate'`).run(id).changes;
    for (const p of rows(`SELECT id FROM kb_merchant_products WHERE merchant_id = ?`, id)) rejectProduct(p.id, code);
    return n > 0;
  };

  // --- foods: entities that are not dishes/drinks (restaurants, species, streets, phrases, cooking methods)
  const encyclopedic = rows(
    `SELECT f.id, f.canonical_name, e.quote FROM kb_food_entities f JOIN kb_food_names n ON n.entity_id = f.id AND n.kind = 'canonical' JOIN kb_evidence e ON e.id = n.evidence_id
     JOIN kb_sources s ON s.id = e.source_id WHERE f.status IN ('published', 'review') AND s.source_type = 'encyclopedia'`
  );
  add(
    "NOT_A_DISH_ENTITY",
    encyclopedic.filter((r) => NOT_A_DISH_TITLE.test(r.canonical_name) || isCookingMethod(r.canonical_name, knowledge.vocabulary) || isNotADish(r.quote)).map((r) => ({ id: r.id, label: r.canonical_name })),
    (i) => rejectEntity(i.id, "NOT_A_DISH_ENTITY")
  );
  // --- foods: a name still published although its entity is not
  add(
    "ORPHAN_FOOD_NAME",
    rows(`SELECT n.id, n.name FROM kb_food_names n JOIN kb_food_entities f ON f.id = n.entity_id WHERE n.status = 'published' AND f.status NOT IN ('published')`).map((r) => ({ id: r.id, label: r.name })),
    (i) => db.prepare(`UPDATE kb_food_names SET status = 'rejected', review_reason = 'AUDIT:ORPHAN_FOOD_NAME' WHERE id = ?`).run(i.id).changes > 0
  );
  // --- merchants: generic headings / article titles taken as places
  const foodNames = rows(`SELECT n.name FROM kb_food_names n JOIN kb_food_entities f ON f.id = n.entity_id WHERE f.status IN ('published', 'review') AND n.status != 'rejected' AND n.kind != 'no_accent'`);
  add(
    "GENERIC_MERCHANT_NAME",
    rows(`SELECT id, name FROM kb_merchants WHERE status = 'candidate'`).filter((m) => isGenericPlaceName(m.name, foodNames)).map((m) => ({ id: m.id, label: m.name })),
    (i) => rejectMerchant(i.id, "GENERIC_MERCHANT_NAME")
  );
  // --- merchants: the name re-derived from the SAME heading evidence with the current rule
  const named = rows(
    `SELECT m.id, m.name, c.id AS claim_id, e.quote FROM kb_merchants m JOIN kb_merchant_claims c ON c.merchant_id = m.id AND c.field = 'name'
     JOIN kb_evidence e ON e.id = c.evidence_id WHERE m.status = 'candidate' AND e.proposed_by = 'collector:listicle'`
  );
  const renames = named.map((r) => ({ ...r, next: placeNameFromHeading(r.quote) })).filter((r) => r.next !== r.name);
  add(
    "MERCHANT_NAME_RECOMPUTED",
    renames.map((r) => ({ ...r, label: `${r.name} -> ${r.next ?? "(not a place)"}` })),
    (i) => {
      if (!i.next) return rejectMerchant(i.id, "MERCHANT_NAME_RECOMPUTED");
      db.prepare(`UPDATE kb_merchants SET name = ?, normalized_name = ?, updated_at = datetime('now') WHERE id = ?`).run(i.next, normalizeName(i.next), i.id);
      db.prepare(`UPDATE kb_merchant_claims SET original_text = ? WHERE id = ?`).run(i.next, i.claim_id);
      // the corrected name may now equal another merchant's: a candidate pair for a person (never merged)
      for (const twin of rows(`SELECT id FROM kb_merchants WHERE normalized_name = ? AND id != ? AND status IN ('candidate', 'verified')`, normalizeName(i.next), i.id)) {
        const [a, b] = twin.id < i.id ? [twin.id, i.id] : [i.id, twin.id];
        db.prepare(`INSERT OR IGNORE INTO kb_duplicate_candidates (merchant_a, merchant_b, signals_json, score) VALUES (?, ?, ?, ?)`).run(a, b, JSON.stringify({ same_normalized_name: true, after_name_correction: true }), 0.5);
      }
      return true;
    }
  );
  // --- merchants: a listing whose own section says nothing about food (an attraction, a temple, an island)
  const sectionsBySource = new Map();
  const sectionsOf = (source) => {
    if (!sectionsBySource.has(source.id)) {
      const file = path.resolve(knowledge.rawRoot, source.raw_path);
      sectionsBySource.set(source.id, fs.existsSync(file) && String(source.content_type).includes("html") ? listicleSections(fs.readFileSync(file, "utf8")) : null);
    }
    return sectionsBySource.get(source.id);
  };
  const listed = rows(
    `SELECT m.id, m.name, e.quote, s.id AS source_id, s.raw_path, s.content_type FROM kb_merchants m JOIN kb_merchant_claims c ON c.merchant_id = m.id AND c.field = 'name'
     JOIN kb_evidence e ON e.id = c.evidence_id JOIN kb_sources s ON s.id = e.source_id WHERE m.status = 'candidate' AND e.proposed_by = 'collector:listicle'`
  );
  add(
    "NON_FOOD_PLACE",
    listed
      .filter((r) => {
        const section = sectionsOf({ id: r.source_id, raw_path: r.raw_path, content_type: r.content_type })?.find((s) => s.heading === r.quote);
        return section && !isFoodPlaceSection(section, foodNames);
      })
      .map((r) => ({ id: r.id, label: r.name })),
    (i) => rejectMerchant(i.id, "NON_FOOD_PLACE")
  );
  add(
    "MERCHANT_WITHOUT_ADDRESS_EVIDENCE",
    rows(`SELECT id, name FROM kb_merchants m WHERE status = 'candidate' AND NOT EXISTS (SELECT 1 FROM kb_merchant_locations l WHERE l.merchant_id = m.id AND l.status = 'published')`).map((m) => ({ id: m.id, label: m.name }))
  );
  // --- products: from an address line, a related-article link or a photo caption
  const mentions = rows(
    `SELECT p.id, p.merchant_id, p.original_name, e.quote FROM kb_merchant_products p JOIN kb_evidence e ON e.id = p.evidence_id WHERE p.observation = 'mention' AND p.status != 'rejected'`
  );
  const headingOf = db.prepare(`SELECT 1 FROM kb_merchant_claims c JOIN kb_evidence e ON e.id = c.evidence_id WHERE c.merchant_id = ? AND c.field = 'name' AND e.quote = ?`);
  add(
    "PRODUCT_FROM_ADDRESS_OR_LINK",
    mentions.filter((p) => !headingOf.get(p.merchant_id, p.quote) && !isDishText(p.quote) && !/^(?:\S+\s+)?(?:giá|mức giá|giá tham khảo)/iu.test(p.quote)).map((p) => ({ id: p.id, label: `${p.original_name} <= ${p.quote.slice(0, 60)}` })),
    (i) => rejectProduct(i.id, "PRODUCT_FROM_ADDRESS_OR_LINK")
  );
  add(
    "PRODUCT_FROM_PHOTO_CAPTION",
    mentions.filter((p) => !` ${normalizeName(p.quote.split(CAPTION)[0])} `.includes(` ${normalizeName(p.original_name)} `)).map((p) => ({ id: p.id, label: p.original_name })),
    (i) => rejectProduct(i.id, "PRODUCT_FROM_PHOTO_CAPTION")
  );
  add(
    "ORPHAN_MERCHANT_PRODUCT",
    rows(`SELECT id, original_name FROM kb_merchant_products WHERE status = 'published' AND merchant_id NOT IN (${LIVE})`).map((p) => ({ id: p.id, label: p.original_name })),
    (i) => rejectProduct(i.id, "ORPHAN_MERCHANT_PRODUCT")
  );
  // --- published encyclopedia facts re-derived from their own sentence with the CURRENT rules
  // the current RULES, over the dishes known when the fact was made (a dish added later — "Bánh phở" — must not
  // turn an old, correct single-dish sentence into a "two dishes" one)
  const allNames = rows(`SELECT e.key, e.created_at, n.name FROM kb_food_entities e JOIN kb_food_names n ON n.entity_id = e.id AND n.status = 'published' WHERE e.status = 'published'`);
  const namesAt = new Map();
  const namesKnownAt = (when) => {
    if (!namesAt.has(when)) {
      const m = new Map();
      for (const r of allNames) if (r.created_at <= when) (m.get(r.key) ?? m.set(r.key, []).get(r.key)).push(r.name);
      namesAt.set(when, m);
    }
    return namesAt.get(when);
  };
  const regionList = rows(`SELECT id, level FROM kb_regions`).map((r) => ({ id: r.id, level: r.level, names: knowledge.regionNames(r.id), name: knowledge.regionNames(r.id)[0] }));
  const lexiconClaims = rows(
    `SELECT c.id, c.kind, c.key, c.value, c.level, c.created_at, f.key AS entity_key, f.canonical_name, e.quote FROM kb_claims c JOIN kb_food_entities f ON f.id = c.entity_id
     JOIN kb_evidence e ON e.id = c.evidence_id WHERE c.status = 'published' AND f.status = 'published' AND e.proposed_by = 'collector:wikipedia-lexicon' AND e.extraction = 'explicit'`
  );
  const canonicalCache = new Map();
  const notReproduced = lexiconClaims.filter((c) => {
    if (!canonicalCache.has(c.entity_key)) canonicalCache.set(c.entity_key, canonicalNamesOf(knowledge, c.entity_key));
    const namesByEntity = namesKnownAt(c.created_at);
    const found = [
      ...proposalsFromSentence({ sentence: c.quote, entityKey: c.entity_key, namesByEntity, vocabulary: knowledge.vocabulary, regions: regionList.filter((r) => r.level !== "country"), originRegions: regionList, canonicalNames: canonicalCache.get(c.entity_key) }),
      ...variantProposals({ sentence: c.quote, entityKey: c.entity_key, namesByEntity }),
    ];
    const same = found.find((p) => p.kind === c.kind && p.key === c.key && (p.value ?? null) === (c.value ?? null) && (p.level ?? null) === (c.level ?? null));
    return !same || same.aliasSubject || same.hedged;
  });
  add(
    "FACT_NOT_REPRODUCED_BY_CURRENT_RULES",
    notReproduced.map((c) => ({ id: c.id, label: `${c.canonical_name}: ${c.kind} ${c.key}=${c.value ?? ""}${c.level ? `/${c.level}` : ""}` })),
    (i) => db.prepare(`UPDATE kb_claims SET status = 'review', review_reason = 'AUDIT:NOT_REPRODUCED_BY_CURRENT_RULES', updated_at = datetime('now') WHERE id = ? AND status = 'published'`).run(i.id).changes > 0
  );
  // --- published encyclopedia facts of a kind the extraction policy now keeps for review (measured below target)
  const reviewKinds = Object.entries(policy?.auto_publish ?? {}).filter(([, v]) => v === false).map(([k]) => k);
  const againstPolicy = reviewKinds.length
    ? rows(
        `SELECT c.id, c.kind, c.key, c.value, f.canonical_name FROM kb_claims c JOIN kb_food_entities f ON f.id = c.entity_id JOIN kb_evidence e ON e.id = c.evidence_id
         WHERE c.status = 'published' AND e.proposed_by = 'collector:wikipedia-lexicon' AND c.kind IN (${reviewKinds.map(() => "?").join(",")})
           AND (c.review_reason IS NULL OR c.review_reason NOT LIKE 'approved by%')`,
        ...reviewKinds
      )
    : [];
  add(
    "PUBLISHED_AGAINST_POLICY",
    againstPolicy.map((c) => ({ id: c.id, label: `${c.canonical_name}: ${c.kind} ${c.key}=${c.value ?? ""}` })),
    (i) => db.prepare(`UPDATE kb_claims SET status = 'review', review_reason = 'AUDIT:POLICY_REVIEW_ONLY', updated_at = datetime('now') WHERE id = ? AND status = 'published'`).run(i.id).changes > 0
  );
  // --- links published as 'exact' although the product only equals an ALIAS of the food (current rule: review)
  add(
    "ALIAS_LINK_PUBLISHED",
    rows(
      `SELECT l.id, p.original_name, f.canonical_name FROM kb_food_product_links l JOIN kb_merchant_products p ON p.id = l.kb_product_id JOIN kb_food_entities f ON f.id = l.food_entity_id
       WHERE l.status = 'published' AND l.match_type = 'exact' AND l.decided_by IS NULL
         AND NOT EXISTS (SELECT 1 FROM kb_food_names n WHERE n.entity_id = f.id AND n.status = 'published' AND n.kind IN ('canonical', 'no_accent') AND n.normalized = p.normalized_name)`
    ).map((r) => ({ id: r.id, label: `${r.original_name} -> ${r.canonical_name}` })),
    (i) => db.prepare(`UPDATE kb_food_product_links SET status = 'review', match_type = 'alias', confidence = 0.8, review_reason = 'AUDIT:ALIAS_MATCH', updated_at = datetime('now') WHERE id = ?`).run(i.id).changes > 0
  );
  // --- provenance
  add("LINK_WITHOUT_EVIDENCE", rows(`SELECT id FROM kb_food_product_links WHERE status = 'published' AND evidence_id IS NULL AND match_type != 'manual'`).map((r) => ({ id: r.id, label: `link ${r.id}` })));
  add("PRICE_WITHOUT_EVIDENCE", rows(`SELECT id FROM kb_product_prices WHERE status = 'published' AND evidence_id IS NULL`).map((r) => ({ id: r.id, label: `price ${r.id}` })));
  add(
    "CLAIM_WITHOUT_VERIFIED_EVIDENCE",
    rows(`SELECT c.id FROM kb_claims c LEFT JOIN kb_evidence e ON e.id = c.evidence_id WHERE c.status = 'published' AND (e.id IS NULL OR e.verification != 'verified')`).map((r) => ({ id: r.id, label: `claim ${r.id}` }))
  );
  add(
    "PUBLISHED_RULE_DERIVED_CLAIM",
    rows(`SELECT c.id, c.key FROM kb_claims c JOIN kb_evidence e ON e.id = c.evidence_id WHERE c.status = 'published' AND e.extraction = 'rule' AND (c.review_reason IS NULL OR c.review_reason NOT LIKE 'approved by%')`).map((r) => ({ id: r.id, label: `claim ${r.id} ${r.key}` }))
  );
  // --- prices: implausible values / currency
  add(
    "INVALID_PRICE",
    rows(`SELECT id, price, currency, price_text_original FROM kb_product_prices WHERE status = 'published' AND (price IS NOT NULL AND (price <= 0 OR price > ${MAX_PLAUSIBLE_VND}) OR currency IS NOT NULL AND currency != 'VND')`).map((r) => ({ id: r.id, label: `${r.price_text_original} -> ${r.price} ${r.currency}` })),
    (i) => db.prepare(`UPDATE kb_product_prices SET status = 'rejected' WHERE id = ?`).run(i.id).changes > 0
  );
  // --- merchants at the same written house-number address whose names share a distinctive word
  // ("Nem Đặng Văn Quyên" / "Nem nướng Đặng Văn Quyên"): a duplicate CANDIDATE for a person, never a merge
  const GENERIC_NAME_WORDS = new Set(["quan", "nha", "hang", "nha trang", "trang", "bun", "banh", "com", "pho", "ca", "an", "the", "restaurant", "cafe", "nem", "nuong", "hai", "san", "co", "ba", "chi", "anh"]);
  const locs = rows(`SELECT m.id, m.name, l.address_original FROM kb_merchants m JOIN kb_merchant_locations l ON l.merchant_id = m.id AND l.status = 'published' WHERE m.status IN ('candidate', 'verified')`);
  const byAddr = new Map();
  for (const r of locs) {
    const k = addressKey(r.address_original);
    if (k) (byAddr.get(k) ?? byAddr.set(k, []).get(k)).push(r);
  }
  const pairs = [];
  const words = (n) => new Set(normalizeName(n).split(" ").filter((w) => w.length > 1 && !GENERIC_NAME_WORDS.has(w)));
  for (const [key, group] of byAddr) {
    for (let i = 0; i < group.length; i++) for (let j = i + 1; j < group.length; j++) {
      const [x, y] = [group[i], group[j]];
      if (x.id === y.id || normalizeName(x.name) === normalizeName(y.name)) continue; // equal names are already paired at insert time
      const shared = [...words(x.name)].filter((w) => words(y.name).has(w));
      if (shared.length === 0) continue;
      const [a, b] = x.id < y.id ? [x, y] : [y, x];
      if (db.prepare(`SELECT 1 FROM kb_duplicate_candidates WHERE merchant_a = ? AND merchant_b = ?`).get(a.id, b.id)) continue;
      if (pairs.some((p) => p.a === a.id && p.b === b.id)) continue; // several location rows of one merchant
      pairs.push({ a: a.id, b: b.id, key, shared, label: `${a.name} ~ ${b.name} @ ${key}` });
    }
  }
  add("SAME_ADDRESS_SIMILAR_NAME_UNPAIRED", pairs, (p) =>
    db.prepare(`INSERT OR IGNORE INTO kb_duplicate_candidates (merchant_a, merchant_b, signals_json, score) VALUES (?, ?, ?, ?)`).run(p.a, p.b, JSON.stringify({ same_address: true, address_key: p.key, shared_name_words: p.shared }), 0.7).changes > 0
  );
  // --- prices whose verbatim text the (fixed) parser reads now: the number comes from the SAME stored text
  const unparsed = rows(`SELECT id, price_text_original FROM kb_product_prices WHERE status = 'published' AND price IS NULL`)
    .map((r) => ({ ...r, parsed: parsePrice(r.price_text_original) }))
    .filter((r) => r.parsed.price !== null);
  add(
    "PRICE_NUMBER_MISSING",
    unparsed.map((r) => ({ ...r, label: `${r.price_text_original} -> ${r.parsed.price}` })),
    (r) => db.prepare(`UPDATE kb_product_prices SET price = ?, price_max = ?, currency = ? WHERE id = ? AND price IS NULL`).run(r.parsed.price, r.parsed.priceMax, r.parsed.currency, r.id).changes > 0
  );
  // --- review-only reports (a person decides)
  add("FOOD_DUPLICATE_CANDIDATES_PENDING", rows(`SELECT id FROM kb_food_duplicate_candidates WHERE status = 'pending'`).map((r) => ({ id: r.id, label: `pair ${r.id}` })));
  add("MERCHANT_DUPLICATE_CANDIDATES_PENDING", rows(`SELECT id FROM kb_duplicate_candidates WHERE status = 'pending'`).map((r) => ({ id: r.id, label: `pair ${r.id}` })));
  add("OPEN_SOURCE_CONFLICTS", rows(`SELECT id, subject_key FROM kb_source_conflicts WHERE status = 'open'`).map((r) => ({ id: r.id, label: r.subject_key })));
  return { audited_at: new Date().toISOString(), fix, checks };
}
