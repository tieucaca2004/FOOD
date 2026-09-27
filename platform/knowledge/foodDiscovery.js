import fs from "node:fs";
import Database from "better-sqlite3";
import { FoodTaxonomy } from "./taxonomy.js";
import { FoodVocabulary } from "./vocabulary.js";
import { FoodSemanticParser } from "./semanticParser.js";
import { normalizeName } from "./text.js";
import { isStale } from "./freshness.js";
import { distanceMeters, addressKey } from "./discoveryStore.js";

// Food Discovery (read-only). FoodQuery -> food entities -> merchant products
// -> merchants, with prices / location / opening hours / ratings AS RECORDED
// (each with its source and date). It never writes anything, never creates a
// cart or an order, and never calls anything "the best": results are only
// ordered by what the customer asked for (rating, reviews, distance, price,
// menu size), else by how many of the asked-for criteria are KNOWN to match.
//
// Tri-state matching: every filter is yes / no / unknown against published
// evidence. `must` keeps only "yes"; a soft `avoid` removes only known "yes";
// a hard `mustNot` ("dị ứng tôm") also removes "unknown" — unless the
// ingredient list is known complete — because an allergy is not a guess.

const OSM_CUISINE = JSON.parse(fs.readFileSync(new URL("./lexicon/osm_cuisine.json", import.meta.url), "utf8")).map;
const DAY_KEYS = ["su", "mo", "tu", "we", "th", "fr", "sa"];

export function openKnowledgeReadOnly(dbPath) {
  return new Database(dbPath, { readonly: true, fileMustExist: true });
}

export class FoodDiscoveryService {
  /**
   * @param {object} deps
   * @param {import("better-sqlite3").Database} deps.db knowledge.db (read-only connection recommended)
   * @param {(ref: {platformMerchantId: string, platformProductId?: number}) => boolean} [deps.isOrderable]
   *   answers from the PLATFORM catalog whether something can be ordered; default: nothing is.
   */
  constructor({ db, taxonomy = new FoodTaxonomy(), vocabulary = null, isOrderable = null, now = () => new Date() }) {
    this.db = db;
    this.taxonomy = taxonomy;
    this.vocabulary = vocabulary ?? new FoodVocabulary(undefined, taxonomy);
    this.isOrderable = isOrderable ?? (() => false);
    this.now = now;
    this._parser = null;
  }

  parser() {
    if (!this._parser) {
      const foodNames = this.db.prepare(`SELECT entity_key AS entityKey, name FROM kb_published_names`).all();
      const regions = this.db.prepare(`SELECT id, name FROM kb_regions WHERE level != 'country'`).all();
      this._parser = new FoodSemanticParser({ taxonomy: this.taxonomy, vocabulary: this.vocabulary, foodNames, regions });
    }
    return this._parser;
  }

  // ------------------------------------------------------------------ foods

  _entities() {
    return this.db.prepare(`SELECT id, key, canonical_name FROM kb_food_entities WHERE status = 'published' ORDER BY key`).all();
  }

  _claims(entityKey) {
    return this.db.prepare(`SELECT * FROM kb_published_claims WHERE entity_key = ?`).all(entityKey);
  }

  _names(entityKey) {
    return this.db.prepare(`SELECT normalized FROM kb_published_names WHERE entity_key = ?`).all(entityKey).map((r) => r.normalized);
  }

  /** yes / no / unknown for one filter item against one entity's published claims. */
  _evaluate(item, entity, claims) {
    const kind = item.concept === "ingredient" ? "ingredient" : item.concept.startsWith("facet:") ? "facet" : item.concept.startsWith("relation:") ? "relation" : "attribute";
    const name = item.concept.includes(":") ? item.concept.split(":")[1] : item.concept;
    if (kind === "ingredient") {
      const has = claims.some((c) => c.kind === "ingredient" && c.value !== "served_with" && item.values.some((v) => this.taxonomy.ingredientIsA(c.key, v)));
      if (has) return "yes";
      const complete = claims.some((c) => c.kind === "ingredient_completeness" && c.value === "complete");
      return complete ? "no" : "unknown";
    }
    if (kind === "facet") {
      const accepted = new Set(item.values.flatMap((v) => this.taxonomy.facetDescendants(name, v)));
      return claims.some((c) => c.kind === "facet" && c.key === name && accepted.has(c.value)) ? "yes" : "unknown";
    }
    if (kind === "relation") {
      // a specialty of the wider region counts for a place inside it ("đặc sản Nha Trang" ⊇ Khánh Hòa specialties)
      const accepted = new Set(item.values.flatMap((v) => this._regionAndAncestors(v)));
      return claims.some((c) => c.kind === "relation" && c.key === name && (item.values.length === 0 || accepted.has(c.value))) ? "yes" : "unknown";
    }
    // graded / enum attributes: typical scope only (regional and variant facts are not "the dish")
    const own = claims.filter((c) => c.kind === "attribute" && c.key === item.concept && c.scope === "typical");
    if (own.length === 0) return "unknown";
    const hit = own.some((c) => (item.levels ? item.levels.includes(c.level) : item.values.includes(c.value)));
    return hit ? "yes" : "no";
  }

  _regionAndAncestors(id) {
    const out = [];
    for (let cur = id; cur; cur = this.db.prepare(`SELECT parent_id FROM kb_regions WHERE id = ?`).get(cur)?.parent_id) {
      const level = this.db.prepare(`SELECT level FROM kb_regions WHERE id = ?`).get(cur)?.level;
      if (level === "country") break; // "a specialty of Vietnam" says nothing about a city
      out.push(cur);
    }
    return out;
  }

  regionName(id) {
    return this.db.prepare(`SELECT name FROM kb_regions WHERE id = ?`).get(id)?.name ?? id;
  }

  // A family of dishes by name ("bánh", "bún", "bánh canh"): taxonomy keys are unaccented slugs of the word.
  _inCategory(cat, entity, claims) {
    const family = cat.value.replace(/_/g, " ");
    const byName = this._names(entity.key).some((n) => n === family || n.startsWith(`${family} `));
    return byName || claims.some((c) => c.kind === "facet" && c.key === cat.facet && c.value === cat.value);
  }

  /** Food entities for a FoodQuery, each with how it matched (never a quality score). */
  matchFoods(q) {
    const hasFoodFilter = q.must.length + q.mustNot.length + q.avoid.length + q.prefer.length + q.categories.length > 0;
    const pool = q.foods.length ? this._entities().filter((e) => q.foods.some((f) => f.entityKey === e.key)) : hasFoodFilter ? this._entities() : [];
    // Nothing positive asked ("tìm món không cay", "món nóng nóng"): only dishes KNOWN to fit are
    // answers — never the whole list of dishes whose spiciness nobody recorded.
    const onlyNegativeOrSoft = q.foods.length === 0 && q.must.length === 0 && q.categories.length === 0;
    const out = [];
    for (const entity of pool) {
      const claims = this._claims(entity.key);
      if (q.categories.length && !q.categories.every((c) => this._inCategory(c, entity, claims))) continue;
      const verdict = { entity, matched: [], unknown: [], excludedBy: null, preferMatched: 0 };
      for (const item of q.must) {
        const r = this._evaluate(item, entity, claims);
        if (r === "yes") verdict.matched.push(item.concept);
        else if (r === "unknown") verdict.unknown.push(item.concept);
        else verdict.excludedBy = item.concept;
      }
      for (const item of q.mustNot) {
        const r = this._evaluate(item, entity, claims);
        if (r !== "no" && (r === "yes" || item.hard)) verdict.excludedBy ??= `${item.concept}${r === "unknown" ? " (chưa rõ)" : ""}`;
      }
      let knownAbsent = 0;
      for (const item of q.avoid) {
        const r = this._evaluate(item, entity, claims);
        if (r === "yes") verdict.excludedBy ??= item.concept;
        else if (r === "no") knownAbsent += 1;
        else verdict.unknown.push(`${item.concept} (tránh)`);
      }
      for (const item of q.prefer) if (this._evaluate(item, entity, claims) === "yes") verdict.preferMatched += 1;
      // "must" needs KNOWN matches; unknowns are reported, not assumed
      const mustUnknown = verdict.unknown.filter((u) => !u.endsWith("(tránh)")).length;
      verdict.ok = !verdict.excludedBy && mustUnknown === 0;
      if (onlyNegativeOrSoft) {
        const asked = q.avoid.length + q.mustNot.length;
        verdict.ok = !verdict.excludedBy && (verdict.preferMatched > 0 || (asked > 0 && knownAbsent + q.mustNot.filter((i) => this._evaluate(i, entity, claims) === "no").length >= asked));
      }
      verdict.claims = claims;
      out.push(verdict);
    }
    return out;
  }

  // ------------------------------------------------------------------ merchants

  _merchantDetails(merchantId, { userLocation } = {}) {
    const m = this.db.prepare(`SELECT id, key, name FROM kb_merchants WHERE id = ?`).get(merchantId);
    const location = this.db
      .prepare(`SELECT * FROM kb_merchant_locations WHERE merchant_id = ? AND status = 'published' ORDER BY captured_at DESC, id DESC LIMIT 1`)
      .get(merchantId);
    const ratings = this.db.prepare(`SELECT r.*, s.url AS source_url FROM kb_v_latest_ratings r JOIN kb_evidence e ON e.id = r.evidence_id JOIN kb_sources s ON s.id = e.source_id WHERE r.merchant_id = ?`).all(merchantId);
    const claims = this.db.prepare(`SELECT field, value_json, original_text, captured_at, conflict FROM kb_merchant_claims WHERE merchant_id = ? AND status = 'published'`).all(merchantId);
    const stats = this.db.prepare(`SELECT product_count, food_count, category_count, menu_last_seen_at FROM kb_v_merchant_menu_stats WHERE kb_merchant_id = ?`).get(merchantId) || { product_count: 0 };
    const bridge = this.db.prepare(`SELECT platform_merchant_id FROM kb_merchant_links WHERE kb_merchant_id = ?`).get(merchantId)?.platform_merchant_id ?? null;
    const distance = userLocation && location?.latitude !== null && location ? distanceMeters(userLocation, { lat: location.latitude, lng: location.longitude }) : null;
    return {
      id: m.id,
      name: m.name,
      location: location ? { address: location.address_original || null, street: location.street, regionId: location.region_id ?? null, lat: location.latitude, lng: location.longitude, capturedAt: location.captured_at, conflict: Boolean(location.conflict) } : null,
      distanceMeters: distance === null ? null : Math.round(distance),
      ratings: ratings.map((r) => ({ source: r.rating_source, rating: r.rating, scale: r.rating_scale, reviewCount: r.review_count, capturedAt: r.captured_at, stale: isStale("rating", r.last_seen_at, this.now()), sourceUrl: r.source_url })),
      openingHours: claims.filter((c) => c.field === "opening_hours").map((c) => ({ text: c.original_text, structured: c.value_json ? JSON.parse(c.value_json) : null, capturedAt: c.captured_at, conflict: Boolean(c.conflict) })),
      cuisine: claims.filter((c) => c.field === "cuisine").flatMap((c) => (c.value_json ? JSON.parse(c.value_json) : [c.original_text])),
      menuCount: stats.product_count ?? 0,
      platformMerchantId: bridge,
      orderable: bridge ? Boolean(this.isOrderable({ platformMerchantId: bridge })) : false,
    };
  }

  /** open / closed / unknown from STRUCTURED hours only (text-only hours never answer "open now"). */
  openStatus(merchant, at = this.now()) {
    const structured = merchant.openingHours.filter((h) => h.structured && !h.conflict);
    if (structured.length !== 1) return "unknown";
    const ranges = structured[0].structured[DAY_KEYS[at.getDay()]] ?? [];
    const hhmm = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
    return ranges.some(([a, b]) => hhmm >= a && hhmm < b) ? "open" : "closed";
  }

  _productsForEntity(entity) {
    const linked = this.db
      .prepare(`SELECT kb_product_id, kb_merchant_id, product_name, platform_merchant_id, platform_product_id, match_type FROM kb_v_food_merchant_products WHERE food_entity_id = ?`)
      .all(entity.id)
      .map((r) => ({ ...r, match: "linked" }));
    // name search over reference products, clearly labelled as such (not a knowledge link)
    const names = this._names(entity.key);
    const seen = new Set(linked.map((l) => l.kb_product_id));
    const byName = this.db
      .prepare(`SELECT id AS kb_product_id, merchant_id AS kb_merchant_id, original_name AS product_name, normalized_name FROM kb_merchant_products WHERE status = 'published'`)
      .all()
      .filter((p) => !seen.has(p.kb_product_id) && names.some((n) => ` ${p.normalized_name} `.includes(` ${n} `)))
      .map((p) => ({ ...p, match: "name" }));
    return [...linked, ...byName];
  }

  _latestPrice(productId) {
    const rows = this.db
      .prepare(`SELECT p.*, s.url AS source_url FROM kb_v_latest_prices p JOIN kb_evidence e ON e.id = p.evidence_id JOIN kb_sources s ON s.id = e.source_id WHERE p.product_id = ? ORDER BY p.variant IS NOT NULL, p.price`)
      .all(productId);
    return rows.map((r) => ({ variant: r.variant, price: r.price, priceMax: r.price_max, text: r.price_text_original, capturedAt: r.captured_at, stale: isStale("price", r.last_seen_at, this.now()), conflict: Boolean(r.conflict), sourceUrl: r.source_url }));
  }

  _merchantsByCuisine(items) {
    const wanted = items.filter((i) => i.concept === "ingredient" || i.concept.startsWith("facet:"));
    if (!wanted.length) return [];
    return this.db
      .prepare(`SELECT merchant_id, value_json FROM kb_merchant_claims WHERE field = 'cuisine' AND status = 'published'`)
      .all()
      .filter((row) => {
        // OSM stores a list of cuisine tags; an article heading stores one {facet, key} (e.g. dietary: vegetarian)
        const raw = row.value_json ? JSON.parse(row.value_json) : [];
        const tags = Array.isArray(raw) ? raw : [raw];
        const concepts = tags.flatMap((t) => (typeof t === "string" ? OSM_CUISINE[t] ?? [] : t?.key ? [{ concept: `facet:${t.facet}`, value: t.key }] : []));
        return wanted.some((w) => concepts.some((c) => c.concept === w.concept && (w.values ?? []).some((v) => (c.concept === "ingredient" ? this.taxonomy.ingredientIsA(c.value, v) || this.taxonomy.ingredientIsA(v, c.value) : c.value === v))));
      })
      .map((r) => r.merchant_id);
  }

  /**
   * Merchants a message NAMES ("Bún Cá Mịn", "Fish House", "Nem Đặng Văn Quyên"): the name phrase left after
   * filler / place words must not be just a dish name, and must be a whole-word part of the merchant's OWN name.
   * No fuzzy matching.
   */
  _merchantsByName(text) {
    const core = ` ${normalizeName(text)} `
      .replace(/ (?:tim|kiem|cho|xem|mo|quan|quan an|nha hang|tiem|dia chi|o|tai|gan|nha trang|khanh hoa|di|nhe|a|oi|voi|minh|toi|em|anh|chi)(?= )/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!core || !core.includes(" ") || core.length < 5) return [];
    // a phrase that is only dish names ("bun ca", "banh can") names a dish, not a place
    this._dishNameSet ??= new Set(this.db.prepare(`SELECT normalized FROM kb_published_names`).all().map((r) => r.normalized));
    let rest = ` ${core} `;
    for (const n of [...this._dishNameSet].filter((d) => d.includes(" ")).sort((a, b) => b.length - a.length)) rest = rest.split(` ${n} `).join(" ");
    // …nor only a kind of food / place ("hai san", "chay", "mon nhat"): that is a category, answered elsewhere
    const categoryWords = new Set(
      this.vocabulary
        .match(text)
        .matches.filter((m) => m.concept === "ingredient" || m.concept.startsWith("facet:"))
        .flatMap((m) => normalizeName(m.text).split(" "))
    );
    const leftover = rest.trim().split(" ").filter((w) => w && !this._dishNameSet.has(w) && !categoryWords.has(w));
    if (!leftover.length) return [];
    return this.db
      .prepare(`SELECT id, normalized_name FROM kb_merchants WHERE status IN ('candidate', 'verified')`)
      .all()
      .filter((m) => ` ${m.normalized_name} `.includes(` ${core} `))
      .map((m) => m.id);
  }

  /** "quán hải sản", "nhà hàng chay": places whose OWN name says so (the name is its evidence). */
  _merchantsByNameWord(q) {
    const terms = this.vocabulary
      .match(q.text)
      .matches.filter((m) => !m.ambiguous && (m.concept === "ingredient" || m.concept === "facet:cuisine" || m.concept === "facet:dietary"))
      .map((m) => normalizeName(m.text))
      .filter((t) => t.length >= 3);
    if (!terms.length) return [];
    return this.db
      .prepare(`SELECT id, normalized_name FROM kb_merchants WHERE status IN ('candidate', 'verified')`)
      .all()
      .filter((m) => terms.some((t) => ` ${m.normalized_name} `.includes(` ${t} `)))
      .map((m) => m.id);
  }

  _regionAndDescendants(id) {
    const out = new Set([id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const r of this.db.prepare(`SELECT id, parent_id FROM kb_regions`).all()) if (r.parent_id && out.has(r.parent_id) && !out.has(r.id)) {
        out.add(r.id);
        grew = true;
      }
    }
    return out;
  }

  // ------------------------------------------------------------------ search

  /**
   * @param {string|object} input customer text or a FoodQuery
   * @param {{userLocation?: {lat, lng}, limit?: number}} [opts]
   */
  search(input, { userLocation = null, limit = 10 } = {}) {
    const q = typeof input === "string" ? this.parser().parse(input) : input;
    const foods = this.matchFoods(q);
    const notes = [];
    if (q.subjective) notes.push("SUBJECTIVE_NOT_RANKED");
    if (q.outOfScope.length) notes.push("OUT_OF_SCOPE");
    if (q.location.nearMe && !userLocation) notes.push("NEED_USER_LOCATION");

    const byMerchant = new Map();
    const addProduct = (merchantId, product, food) => {
      if (!byMerchant.has(merchantId)) byMerchant.set(merchantId, { merchantId, products: new Map(), foods: new Set() });
      const entry = byMerchant.get(merchantId);
      if (food) entry.foods.add(food);
      if (product && !entry.products.has(product.kb_product_id)) entry.products.set(product.kb_product_id, { ...product, foods: new Set() });
      if (product && food) entry.products.get(product.kb_product_id).foods.add(food);
    };
    // "quán hải sản", "quán Nhật": a question about the KIND of place — answered from the merchants' own
    // cuisine tags, not from "some dish there contains seafood"
    // a place the message NAMES comes first and alone ("Tìm Bún Cá Mịn" asks for that place, not for bún cá)
    const named = this._merchantsByName(q.text);
    const placeWords = q.foods.length === 0 && q.categories.length === 0 && q.must.length > 0 && q.must.every((i) => i.concept === "ingredient" || ["facet:cuisine", "facet:dietary", "facet:dish_form"].includes(i.concept));
    const kindOfPlace = !named.length && placeWords && (q.intent === "find_merchant" || !foods.some((f) => f.ok));
    if (named.length) {
      notes.push("MERCHANT_NAME");
      for (const id of named) {
        addProduct(id, null, null);
        for (const p of this.db.prepare(`SELECT id AS kb_product_id, merchant_id AS kb_merchant_id, original_name AS product_name FROM kb_merchant_products WHERE merchant_id = ? AND status = 'published' ORDER BY id`).all(id)) addProduct(id, { ...p, match: "merchant" }, null);
      }
    } else if (kindOfPlace) {
      notes.push("KIND_OF_PLACE");
      for (const id of new Set([...this._merchantsByCuisine(q.must), ...this._merchantsByNameWord(q)])) addProduct(id, null, null);
    } else {
      for (const f of foods.filter((v) => v.ok)) {
        for (const p of this._productsForEntity(f.entity)) if (p.kb_merchant_id) addProduct(p.kb_merchant_id, p, f.entity.key);
      }
    }
    // "quán nhiều món": every merchant, then ordered by menu size
    if (q.foods.length === 0 && q.must.length === 0 && q.categories.length === 0 && q.sort.length) {
      for (const r of this.db.prepare(`SELECT id FROM kb_merchants WHERE status IN ('candidate','verified')`).all()) addProduct(r.id, null, null);
    }

    let merchants = [...byMerchant.values()].map((entry) => {
      const details = this._merchantDetails(entry.merchantId, { userLocation });
      const products = [...entry.products.values()].map((p) => ({
        id: p.kb_product_id,
        name: p.product_name,
        match: p.match,
        foods: [...p.foods],
        prices: this._latestPrice(p.kb_product_id),
        // orderable only when the PLATFORM catalog says so: a linked platform product, or — for a merchant a
        // person has bridged to the platform — the same dish on that merchant's live menu
        orderable: p.platform_product_id
          ? Boolean(this.isOrderable({ platformMerchantId: p.platform_merchant_id, platformProductId: p.platform_product_id }))
          : details.platformMerchantId
          ? Boolean(this.isOrderable({ platformMerchantId: details.platformMerchantId, productName: p.product_name }))
          : false,
      }));
      return { ...details, products, matchedFoods: [...entry.foods], openStatus: this.openStatus(details) };
    });

    // --- constraints on RECORDED data (unknown never passes a constraint)
    if (q.combine === "all" && q.foods.length > 1) merchants = merchants.filter((m) => q.foods.every((f) => m.matchedFoods.includes(f.entityKey)));
    if (q.price.max !== undefined || q.price.min !== undefined) {
      let withoutPrice = 0;
      merchants = merchants
        .map((m) => {
          const products = m.products.filter((p) => {
            const known = p.prices.filter((x) => x.price !== null);
            if (!known.length) withoutPrice += 1;
            return known.some((x) => (q.price.max === undefined || x.price <= q.price.max) && (q.price.min === undefined || x.price >= q.price.min));
          });
          return { ...m, products };
        })
        .filter((m) => m.products.length);
      if (withoutPrice) notes.push(`PRICE_UNKNOWN:${withoutPrice}`);
    }
    if (q.location.text) {
      const want = normalizeName(q.location.text);
      const before = merchants.length;
      merchants = merchants.filter((m) => m.location && ` ${normalizeName([m.location.address, m.location.street].filter(Boolean).join(" "))} `.includes(` ${want} `));
      if (merchants.length < before) notes.push(`LOCATION_FILTERED:${before - merchants.length}`);
    }
    if (q.location.regionId) {
      // "ở Nha Trang": a place whose recorded location is in that region (a place recorded elsewhere — Cam Ranh — is not)
      const inside = this._regionAndDescendants(q.location.regionId);
      const before = merchants.length;
      merchants = merchants.filter((m) => m.location?.regionId && inside.has(m.location.regionId));
      if (merchants.length < before) notes.push(`REGION_FILTERED:${before - merchants.length}`);
    }
    // the same place listed by several articles (same name, same written address): shown once, the fullest listing
    const seenPlace = new Map();
    for (const m of merchants) {
      const k = `${normalizeName(m.name)}|${addressKey(m.location?.address ?? "") ?? m.id}`;
      const prev = seenPlace.get(k);
      if (!prev || m.products.length > prev.products.length) seenPlace.set(k, m);
    }
    if (seenPlace.size < merchants.length) notes.push(`SAME_PLACE_LISTINGS_COLLAPSED:${merchants.length - seenPlace.size}`);
    merchants = merchants.filter((m) => seenPlace.get(`${normalizeName(m.name)}|${addressKey(m.location?.address ?? "") ?? m.id}`) === m);
    if (q.openNow) {
      const unknown = merchants.filter((m) => m.openStatus === "unknown").length;
      merchants = merchants.filter((m) => m.openStatus === "open");
      if (unknown) notes.push(`OPEN_STATUS_UNKNOWN:${unknown}`);
    }

    // --- ordering: ONLY by what was asked; otherwise by known matches, then name
    const bestRating = (m) => Math.max(-1, ...m.ratings.filter((r) => r.rating !== null).map((r) => r.rating / r.scale));
    const bestReviews = (m) => Math.max(-1, ...m.ratings.map((r) => r.reviewCount ?? -1));
    const cheapest = (m) => Math.min(Infinity, ...m.products.flatMap((p) => p.prices.map((x) => x.price ?? Infinity)));
    const cmp = {
      rating_desc: (a, b) => bestRating(b) - bestRating(a),
      review_count_desc: (a, b) => bestReviews(b) - bestReviews(a),
      distance_asc: (a, b) => (a.distanceMeters ?? Infinity) - (b.distanceMeters ?? Infinity),
      price_asc: (a, b) => cheapest(a) - cheapest(b),
      menu_count_desc: (a, b) => b.menuCount - a.menuCount,
    };
    if (q.sort.includes("rating_desc") && !merchants.some((m) => bestRating(m) >= 0)) notes.push("NO_RATING_DATA");
    merchants.sort((a, b) => {
      for (const s of q.sort) {
        const d = cmp[s]?.(a, b) ?? 0;
        if (d) return d;
      }
      return b.matchedFoods.length - a.matchedFoods.length || a.name.localeCompare(b.name, "vi");
    });

    return {
      query: q,
      foods: foods.map((f) => ({ key: f.entity.key, name: f.entity.canonical_name, ok: f.ok, matched: f.matched, unknown: f.unknown, excludedBy: f.excludedBy, preferMatched: f.preferMatched, facts: this.describe(f.claims) })),
      merchants: merchants.slice(0, limit),
      totalMerchants: merchants.length,
      notes,
    };
  }

  /** The published facts of a dish, each with its source — for "typical" explanations. */
  describe(claims) {
    return claims
      .filter((c) => ["attribute", "facet", "ingredient", "relation"].includes(c.kind))
      .map((c) => ({ kind: c.kind, key: c.key, value: c.value, valueLabel: c.kind === "relation" && this.taxonomy.relation(c.key)?.target === "region" ? this.regionName(c.value) : null, level: c.level, scope: c.scope, confidence: c.confidence, source: c.source_url, sourceType: c.source_type, quote: c.quote }));
  }
}
