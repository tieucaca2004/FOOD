import crypto from "node:crypto";
import { normalizeName, collapseWhitespace } from "./text.js";
import { OUTCOME, decide } from "./validator.js";
import { parsePrice } from "./price.js";

// Merchant discovery writes (knowledge migrations 002/003): merchants,
// their facts, locations, ratings, menus, products, prices and food ↔
// product links. Same contract as KnowledgeStore: every write is a proposal
// checked against verified evidence; nothing is taken on trust; nothing
// here can reach the platform DB, its merchants, menus, carts or orders.
//
//   - dedup: a merchant is the same one only on a STRONG identifier (OSM
//     element, map place id, official snapshot) or a phone/website match at
//     the same address/place; equal names alone only create a duplicate
//     candidate for a person to decide.
//   - history: re-observing the same value only moves last_seen_at; a new
//     value from the same source is a new row (price/rating history).
//   - conflicts: different values from different sources are all kept,
//     flagged, and recorded in kb_source_conflicts — nothing is chosen.

// source_url = one listing on one page ("<url>#<heading>"): re-reading the same page is the same observation
const STRONG_SCHEMES = new Set(["osm", "maps_place_id", "official_snapshot", "source_url"]);
const SAME_PLACE_METERS = 100;
const NAME_TWIN_METERS = 50;
const PRICE_CONFLICT_WINDOW_DAYS = 30;
// merchant facts where two sources disagreeing is a conflict (others are additive: several phones, cuisines…)
const SINGLE_VALUED_FIELDS = new Set(["opening_hours", "open_status", "delivery", "takeaway", "dine_in"]);
export const LINK_CONFIDENCE = Object.freeze({ exact: 0.9, alias: 0.8, variant: 0.6, semantic: 0.5, manual: 0.95 });

function reason(code, message) {
  return { code, message };
}

/** Whole-word, accent-insensitive containment ("Quán Bún Cá" in a quote). */
export function mentions(quote, text) {
  const key = normalizeName(text);
  return Boolean(key) && ` ${normalizeName(quote)} `.includes(` ${key} `);
}

export function distanceMeters(a, b) {
  if ([a?.lat, a?.lng, b?.lat, b?.lng].some((v) => v === null || v === undefined)) return null;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}

function slug(text) {
  return normalizeName(text).replace(/ /g, "-").slice(0, 60) || "merchant";
}

/** "123 Ngô Gia Tự, Phước Tiến, Nha Trang" -> "123 ngo gia tu": house number + street, for comparing written addresses. */
export function addressKey(address) {
  const first = normalizeName(String(address).split(/[,;(]/)[0]);
  const key = first.replace(/^so\s+/, "").replace(/^(\S+)\s+(?:duong|pho)\s+/, "$1 ");
  return /^\d/.test(key) ? key : null;
}

function days(a, b) {
  return Math.abs(Date.parse(a) - Date.parse(b)) / 86_400_000;
}

export class MerchantDiscoveryStore {
  /** @param {{knowledge: import("./store.js").KnowledgeStore}} deps */
  constructor({ knowledge }) {
    this.k = knowledge;
    this.db = knowledge.db;
  }

  // ------------------------------------------------------------------ evidence gate

  // Verifies the evidence, runs the proposal-specific support check, stores
  // the evidence row (for audit, whatever the outcome) and decides.
  _gate(evidence, support) {
    const ev = this.k.verifyEvidence(evidence);
    const hard = [...ev.hard];
    const soft = [...ev.soft];
    if (!hard.length && (ev.pointer || ev.raw.text !== null)) soft.push(...support(collapseWhitespace(evidence.quote)));
    const outcome = decide(hard, soft);
    const evidenceId = ev.source && String(evidence?.quote ?? "").trim() ? this.k.insertEvidence(evidence, ev.source, this.k.verificationOf(hard, soft)) : null;
    return { outcome, reasons: [...hard, ...soft], evidenceId, source: ev.source };
  }

  _domainOfEvidence(evidenceId) {
    return this.db.prepare(`SELECT s.domain, s.id FROM kb_evidence e JOIN kb_sources s ON s.id = e.source_id WHERE e.id = ?`).get(evidenceId);
  }

  // "The same source" is the same site over time (a page fetched again is
  // history, not a second opinion); a source without a domain is itself.
  _origin(evidenceId) {
    const r = this._domainOfEvidence(evidenceId);
    return r?.domain || `source:${r?.id}`;
  }

  _recordConflict(subjectType, subjectKey, table, ids) {
    const sorted = [...new Set(ids)].sort((a, b) => a - b);
    this.db.prepare(`UPDATE ${table} SET conflict = 1 WHERE id IN (${sorted.map(() => "?").join(",")})`).run(...sorted);
    this.db
      .prepare(`INSERT OR IGNORE INTO kb_source_conflicts (subject_type, subject_key, row_ids_json) VALUES (?, ?, ?)`)
      .run(subjectType, subjectKey, JSON.stringify(sorted));
  }

  // ------------------------------------------------------------------ merchants + dedup

  merchant(id) {
    return this.db.prepare(`SELECT * FROM kb_merchants WHERE id = ?`).get(id) || null;
  }

  _latestPoint(merchantId) {
    const row = this.db
      .prepare(`SELECT latitude AS lat, longitude AS lng, address_original FROM kb_merchant_locations WHERE merchant_id = ? AND status = 'published' ORDER BY captured_at DESC, id DESC LIMIT 1`)
      .get(merchantId);
    return row || null;
  }

  _latestAddress(merchantId) {
    return this.db.prepare(`SELECT address_original FROM kb_merchant_locations WHERE merchant_id = ? AND status = 'published' AND address_original != '' ORDER BY captured_at DESC, id DESC LIMIT 1`).get(merchantId)?.address_original ?? null;
  }

  _byIdentifier(scheme, value) {
    return this.db.prepare(`SELECT merchant_id FROM kb_merchant_identifiers WHERE scheme = ? AND value = ?`).get(scheme, String(value))?.merchant_id ?? null;
  }

  // Which existing merchant (if any) this candidate is, and why.
  _resolve({ name, identifiers, lat, lng, address }) {
    for (const id of identifiers.filter((i) => STRONG_SCHEMES.has(i.scheme))) {
      const hit = this._byIdentifier(id.scheme, id.value);
      if (hit) return { merchantId: hit, signal: id.scheme };
    }
    const here = { lat, lng };
    const samePlace = (merchantId) => {
      const p = this._latestPoint(merchantId);
      if (!p) return false;
      const d = distanceMeters(here, p);
      if (d !== null) return d <= SAME_PLACE_METERS;
      return Boolean(address && p.address_original && normalizeName(address) === normalizeName(p.address_original));
    };
    for (const id of identifiers.filter((i) => i.scheme === "phone" || i.scheme === "website")) {
      const hit = this._byIdentifier(id.scheme, id.value);
      if (hit && samePlace(hit)) return { merchantId: hit, signal: `${id.scheme}+place` };
    }
    // equal names are NEVER enough to merge — only to flag
    const twins = this.db
      .prepare(`SELECT id FROM kb_merchants WHERE normalized_name = ? AND status IN ('candidate', 'verified')`)
      .all(normalizeName(name))
      .filter((m) => {
        const p = this._latestPoint(m.id);
        const d = p ? distanceMeters(here, p) : null;
        return d === null ? true : d <= NAME_TWIN_METERS;
      });
    // same name AND the same written address is a stronger hint — still only a candidate for a person
    const sameAddress = (id) => {
      const p = this._latestAddress(id);
      return Boolean(address && p && addressKey(p) && addressKey(p) === addressKey(address));
    };
    return { merchantId: null, twins: twins.map((t) => t.id), twinSignals: Object.fromEntries(twins.map((t) => [t.id, { same_address: sameAddress(t.id) }])) };
  }

  /**
   * A merchant observed in a source. Returns the (existing or new) merchant
   * id, how it was matched, and any duplicate candidate recorded.
   * @param {object} c {name, identifiers: [{scheme, value}], lat?, lng?, address?, seenAt, evidence}
   */
  upsertMerchant(c) {
    const gate = this._gate(c.evidence, (quote) => (mentions(quote, c.name) ? [] : [reason("NOT_SUPPORTED_BY_QUOTE", `the quote does not name "${c.name}"`)]));
    if (gate.outcome !== OUTCOME.PUBLISHED) return { outcome: gate.outcome, reasons: gate.reasons, merchantId: null };
    const identifiers = c.identifiers || [];
    const found = this._resolve({ name: c.name, identifiers, lat: c.lat, lng: c.lng, address: c.address });
    let merchantId = found.merchantId;
    let action = "matched";
    if (merchantId) {
      this.db.prepare(`UPDATE kb_merchants SET last_seen_at = MAX(last_seen_at, ?), updated_at = datetime('now') WHERE id = ?`).run(c.seenAt, merchantId);
    } else {
      action = "created";
      const suffix = crypto.createHash("sha1").update(JSON.stringify([c.name, identifiers, gate.evidenceId])).digest("hex").slice(0, 8);
      merchantId = this.db
        .prepare(`INSERT INTO kb_merchants (key, name, normalized_name, status, first_seen_at, last_seen_at) VALUES (?, ?, ?, 'candidate', ?, ?)`)
        .run(`${slug(c.name)}-${suffix}`, c.name, normalizeName(c.name), c.seenAt, c.seenAt).lastInsertRowid;
      for (const twin of found.twins) {
        const [a, b] = twin < merchantId ? [twin, merchantId] : [merchantId, twin];
        this.db
          .prepare(`INSERT OR IGNORE INTO kb_duplicate_candidates (merchant_a, merchant_b, signals_json, score) VALUES (?, ?, ?, ?)`)
          .run(a, b, JSON.stringify({ same_normalized_name: true, within_meters: NAME_TWIN_METERS, ...(found.twinSignals?.[twin] ?? {}) }), found.twinSignals?.[twin]?.same_address ? 0.8 : 0.5);
      }
      if (found.twins.length) action = "created_with_duplicate_candidate";
    }
    const insertId = this.db.prepare(`INSERT OR IGNORE INTO kb_merchant_identifiers (merchant_id, scheme, value, evidence_id) VALUES (?, ?, ?, ?)`);
    for (const id of identifiers) insertId.run(merchantId, id.scheme, String(id.value), gate.evidenceId);
    this._claimRow({ merchantId, field: "name", value: null, originalText: c.name, evidenceId: gate.evidenceId, capturedAt: c.seenAt, status: "published" });
    return { outcome: OUTCOME.PUBLISHED, reasons: gate.reasons, merchantId, action, matchedBy: found.signal ?? null, duplicateCandidates: found.twins ?? [] };
  }

  // ------------------------------------------------------------------ merchant facts

  _claimRow({ merchantId, field, value, originalText, evidenceId, capturedAt, status, reasons = [] }) {
    const valueJson = value === null || value === undefined ? null : JSON.stringify(value);
    const origin = this._origin(evidenceId);
    const published = this.db
      .prepare(`SELECT * FROM kb_merchant_claims WHERE merchant_id = ? AND field = ? AND status = 'published' ORDER BY captured_at DESC, id DESC`)
      .all(merchantId, field);
    const sameSource = published.find((r) => this._origin(r.evidence_id) === origin);
    if (sameSource && sameSource.original_text === originalText && sameSource.value_json === valueJson) {
      this.db.prepare(`UPDATE kb_merchant_claims SET last_seen_at = MAX(last_seen_at, ?) WHERE id = ?`).run(capturedAt, sameSource.id);
      return { claimId: sameSource.id, touched: true };
    }
    const claimId = this.db
      .prepare(
        `INSERT INTO kb_merchant_claims (merchant_id, field, value_json, original_text, evidence_id, captured_at, last_seen_at, status, review_reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(merchantId, field, valueJson, originalText, evidenceId, capturedAt, capturedAt, status, reasons.map((r) => r.code).join(",") || null).lastInsertRowid;
    if (status === "published" && SINGLE_VALUED_FIELDS.has(field)) {
      const others = published.filter((r) => this._origin(r.evidence_id) !== origin);
      const differing = others.filter((o) => (o.value_json ?? normalizeName(o.original_text)) !== (valueJson ?? normalizeName(originalText)));
      if (differing.length) this._recordConflict("merchant_claim", `merchant:${merchantId}:${field}`, "kb_merchant_claims", [claimId, ...differing.map((d) => d.id)]);
    }
    return { claimId, touched: false };
  }

  /**
   * One fact about a merchant (opening hours, cuisine, phone, delivery…).
   * `originalText` must appear in the quote; `value` is the caller's
   * structured reading of it (null when it could not be read).
   */
  proposeMerchantClaim({ merchantId, field, value = null, originalText, evidence, capturedAt }) {
    if (!this.merchant(merchantId)) throw new Error(`unknown merchant ${merchantId}`);
    const gate = this._gate(evidence, (quote) =>
      mentions(quote, originalText) || quote.includes(collapseWhitespace(originalText)) ? [] : [reason("NOT_SUPPORTED_BY_QUOTE", `the quote does not contain "${originalText}"`)]
    );
    if (gate.outcome === OUTCOME.REJECTED) return { outcome: gate.outcome, reasons: gate.reasons, claimId: null };
    const row = this._claimRow({ merchantId, field, value, originalText, evidenceId: gate.evidenceId, capturedAt, status: gate.outcome, reasons: gate.reasons });
    return { outcome: gate.outcome, reasons: gate.reasons, ...row };
  }

  // ------------------------------------------------------------------ location

  proposeLocation({ merchantId, addressOriginal, street = null, ward = null, area = null, city = null, province = null, regionId = null, lat = null, lng = null, coordinatesFrom = null, evidence, capturedAt }) {
    if (!this.merchant(merchantId)) throw new Error(`unknown merchant ${merchantId}`);
    if (!addressOriginal && lat === null) throw new Error("a location needs an address or coordinates");
    const gate = this._gate(evidence, (quote) => {
      const out = [];
      if (addressOriginal && !mentions(quote, addressOriginal) && !quote.includes(collapseWhitespace(addressOriginal))) out.push(reason("NOT_SUPPORTED_BY_QUOTE", "the quote does not contain the address"));
      if (lat !== null && coordinatesFrom === "source" && !(quote.includes(String(lat)) && quote.includes(String(lng)))) {
        out.push(reason("COORDINATES_NOT_IN_QUOTE", "source coordinates must appear in the evidence"));
      }
      return out;
    });
    if (gate.outcome === OUTCOME.REJECTED) return { outcome: gate.outcome, reasons: gate.reasons, locationId: null };
    const origin = this._origin(gate.evidenceId);
    const published = this.db
      .prepare(`SELECT * FROM kb_merchant_locations WHERE merchant_id = ? AND status = 'published' ORDER BY captured_at DESC, id DESC`)
      .all(merchantId);
    const sameSource = published.find((r) => this._origin(r.evidence_id) === origin);
    if (sameSource && normalizeName(sameSource.address_original) === normalizeName(addressOriginal ?? "") && sameSource.latitude === lat && sameSource.longitude === lng) {
      this.db.prepare(`UPDATE kb_merchant_locations SET last_seen_at = MAX(last_seen_at, ?) WHERE id = ?`).run(capturedAt, sameSource.id);
      return { outcome: OUTCOME.PUBLISHED, reasons: gate.reasons, locationId: sameSource.id, touched: true };
    }
    const locationId = this.db
      .prepare(
        `INSERT INTO kb_merchant_locations (merchant_id, address_original, street, ward, area, city, province, region_id, latitude, longitude, coordinates_from, evidence_id, captured_at, last_seen_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(merchantId, addressOriginal ?? "", street, ward, area, city, province, regionId, lat, lng, lat === null ? null : coordinatesFrom, gate.evidenceId, capturedAt, capturedAt, gate.outcome).lastInsertRowid;
    if (gate.outcome === OUTCOME.PUBLISHED) {
      const others = published.filter((r) => this._origin(r.evidence_id) !== origin);
      const differing = others.filter((o) => {
        const d = distanceMeters({ lat, lng }, { lat: o.latitude, lng: o.longitude });
        return d !== null ? d > SAME_PLACE_METERS : normalizeName(o.address_original) !== normalizeName(addressOriginal ?? "");
      });
      if (differing.length) this._recordConflict("location", `merchant:${merchantId}:location`, "kb_merchant_locations", [locationId, ...differing.map((d) => d.id)]);
    }
    return { outcome: gate.outcome, reasons: gate.reasons, locationId };
  }

  // ------------------------------------------------------------------ ratings (history, per source)

  proposeRating({ merchantId, ratingSource, rating = null, ratingScale = 5, reviewCount = null, evidence, capturedAt }) {
    if (!this.merchant(merchantId)) throw new Error(`unknown merchant ${merchantId}`);
    if (rating === null && reviewCount === null) throw new Error("a rating observation needs a rating or a review count");
    const gate = this._gate(evidence, (quote) => {
      const out = [];
      if (rating !== null && !quote.includes(String(rating)) && !quote.includes(String(rating).replace(".", ","))) out.push(reason("NOT_SUPPORTED_BY_QUOTE", "the rating is not in the quote"));
      if (reviewCount !== null && !quote.replace(/[.,](?=\d{3})/g, "").includes(String(reviewCount))) out.push(reason("NOT_SUPPORTED_BY_QUOTE", "the review count is not in the quote"));
      return out;
    });
    if (gate.outcome === OUTCOME.REJECTED) return { outcome: gate.outcome, reasons: gate.reasons, ratingId: null };
    const latest = this.db
      .prepare(`SELECT * FROM kb_merchant_ratings WHERE merchant_id = ? AND rating_source = ? AND status = 'published' ORDER BY captured_at DESC, id DESC LIMIT 1`)
      .get(merchantId, ratingSource);
    const origin = this._origin(gate.evidenceId);
    const latestOrigin = latest ? this._origin(latest.evidence_id) : null;
    if (latest && latestOrigin === origin && latest.rating === rating && latest.review_count === reviewCount && latest.rating_scale === ratingScale) {
      this.db.prepare(`UPDATE kb_merchant_ratings SET last_seen_at = MAX(last_seen_at, ?) WHERE id = ?`).run(capturedAt, latest.id);
      return { outcome: OUTCOME.PUBLISHED, reasons: gate.reasons, ratingId: latest.id, touched: true };
    }
    const ratingId = this.db
      .prepare(
        `INSERT INTO kb_merchant_ratings (merchant_id, rating_source, rating, rating_scale, review_count, evidence_id, captured_at, last_seen_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(merchantId, ratingSource, rating, ratingScale, reviewCount, gate.evidenceId, capturedAt, capturedAt, gate.outcome).lastInsertRowid;
    // the same rating platform read through a different site, disagreeing at about the same time
    if (gate.outcome === OUTCOME.PUBLISHED && latest && latestOrigin !== origin && latest.rating !== rating && days(latest.captured_at, capturedAt) <= 7) {
      this._recordConflict("rating", `merchant:${merchantId}:rating:${ratingSource}`, "kb_merchant_ratings", [ratingId, latest.id]);
    }
    return { outcome: gate.outcome, reasons: gate.reasons, ratingId };
  }

  // ------------------------------------------------------------------ menus, products, prices

  proposeMenu({ merchantId, name = null, evidence, capturedAt, publishedAt = null }) {
    if (!this.merchant(merchantId)) throw new Error(`unknown merchant ${merchantId}`);
    const gate = this._gate(evidence, () => []);
    if (gate.outcome === OUTCOME.REJECTED) return { outcome: gate.outcome, reasons: gate.reasons, menuId: null };
    // the same menu of the same source seen again is one menu (last_seen moves)
    const origin = this._origin(gate.evidenceId);
    const existing = this.db
      .prepare(`SELECT * FROM kb_menus WHERE merchant_id = ? AND name IS ? ORDER BY id`)
      .all(merchantId, name)
      .find((mn) => this._origin(mn.evidence_id) === origin);
    if (existing) {
      this.db.prepare(`UPDATE kb_menus SET last_seen_at = MAX(last_seen_at, ?) WHERE id = ?`).run(capturedAt, existing.id);
      return { outcome: gate.outcome, reasons: gate.reasons, menuId: existing.id, touched: true };
    }
    const menuId = this.db
      .prepare(`INSERT INTO kb_menus (merchant_id, name, evidence_id, captured_at, source_published_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(merchantId, name, gate.evidenceId, capturedAt, publishedAt, capturedAt).lastInsertRowid;
    return { outcome: gate.outcome, reasons: gate.reasons, menuId };
  }

  category(menuId, name, sortOrder = 0) {
    const existing = this.db.prepare(`SELECT id FROM kb_menu_categories WHERE menu_id = ? AND name = ?`).get(menuId, name);
    if (existing) return existing.id;
    return this.db.prepare(`INSERT INTO kb_menu_categories (menu_id, name, sort_order) VALUES (?, ?, ?)`).run(menuId, name, sortOrder).lastInsertRowid;
  }

  /**
   * A dish as the merchant lists it (observation "menu"), or as a third-party
   * article says the place serves it (observation "mention": no menu, no price).
   * Its name (and description) must be in the quote.
   */
  proposeProduct({ merchantId, menuId = null, categoryId = null, originalName, description = null, availability = "unknown", observation = "menu", evidence, seenAt }) {
    if (!this.merchant(merchantId)) throw new Error(`unknown merchant ${merchantId}`);
    const gate = this._gate(evidence, (quote) => {
      const out = [];
      if (!mentions(quote, originalName)) out.push(reason("NOT_SUPPORTED_BY_QUOTE", `the quote does not list "${originalName}"`));
      if (description && !quote.includes(collapseWhitespace(description))) out.push(reason("DESCRIPTION_NOT_VERBATIM", "a product description must be the merchant's own words"));
      return out;
    });
    if (gate.outcome === OUTCOME.REJECTED) return { outcome: gate.outcome, reasons: gate.reasons, productId: null };
    const normalized = normalizeName(originalName);
    const existing = this.db.prepare(`SELECT * FROM kb_merchant_products WHERE merchant_id = ? AND normalized_name = ?`).get(merchantId, normalized);
    if (existing) {
      // seen on a real menu once = a menu product (a later mention never downgrades it)
      this.db
        .prepare(`UPDATE kb_merchant_products SET last_seen_at = MAX(last_seen_at, ?), menu_id = COALESCE(?, menu_id), category_id = COALESCE(?, category_id), observation = CASE WHEN ? = 'menu' THEN 'menu' ELSE observation END WHERE id = ?`)
        .run(seenAt, menuId, categoryId, observation, existing.id);
      return { outcome: existing.status, reasons: gate.reasons, productId: existing.id, touched: true };
    }
    const productId = this.db
      .prepare(
        `INSERT INTO kb_merchant_products (merchant_id, menu_id, category_id, original_name, normalized_name, description, availability, observation, evidence_id, status, first_seen_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(merchantId, menuId, categoryId, originalName, normalized, description, availability, observation, gate.evidenceId, gate.outcome, seenAt, seenAt).lastInsertRowid;
    return { outcome: gate.outcome, reasons: gate.reasons, productId };
  }

  /**
   * A price observation. The store parses `priceTextOriginal` itself (never
   * a caller's number); unreadable text keeps price NULL.
   */
  /**
   * @param {object} [p.scale] {factor: 1000, evidence} — only when the SAME source declares its prices
   *   in thousands ("All prices are in VND (,000)"); the declaration is itself verified evidence.
   */
  proposePrice({ productId, variant = null, priceTextOriginal, unit = null, evidence, capturedAt, publishedAt = null, scale = null }) {
    const product = this.db.prepare(`SELECT * FROM kb_merchant_products WHERE id = ?`).get(productId);
    if (!product) throw new Error(`unknown product ${productId}`);
    let { price, priceMax, currency } = parsePrice(priceTextOriginal);
    let scaleProblem = null;
    if (scale) {
      const declared = /(?:\(\s*,?000\s*\)|,000|x\s*1\.?000|nghìn đồng|ngàn đồng|thousand)/iu.test(scale.evidence?.quote ?? "");
      const sameSource = scale.evidence?.sourceId === evidence?.sourceId;
      const verified = declared && sameSource && !this.k.verifyEvidence(scale.evidence).hard.length;
      if (verified && Number.isInteger(scale.factor) && scale.factor > 1) {
        // "210" alone is ambiguous to the parser; under a verified "(,000)" declaration it is 210 × 1000
        const bare = String(priceTextOriginal).trim().match(/^(\d{1,4})$/);
        if (price === null && bare) price = Number(bare[1]);
        price = price === null ? null : price * scale.factor;
        priceMax = priceMax === null ? null : priceMax * scale.factor;
        currency = currency ?? "VND";
      } else scaleProblem = reason("PRICE_SCALE_NOT_EVIDENCED", "a price scale needs the source's own verified declaration");
    }
    const gate = this._gate(evidence, (quote) => {
      const out = [];
      if (!quote.includes(collapseWhitespace(priceTextOriginal))) out.push(reason("NOT_SUPPORTED_BY_QUOTE", `the quote does not contain "${priceTextOriginal}"`));
      if (product.status !== "published") out.push(reason("PRODUCT_NOT_PUBLISHED", "the product itself is not published"));
      if (scaleProblem) out.push(scaleProblem);
      return out;
    });
    if (gate.outcome === OUTCOME.REJECTED) return { outcome: gate.outcome, reasons: gate.reasons, priceId: null };
    const origin = this._origin(gate.evidenceId);
    const publishedPrices = this.db
      .prepare(`SELECT * FROM kb_product_prices WHERE product_id = ? AND variant IS ? AND status = 'published' ORDER BY captured_at DESC, id DESC`)
      .all(productId, variant);
    const latestFor = (sameSource) => publishedPrices.find((r) => (this._origin(r.evidence_id) === origin) === sameSource) ?? null;
    const mine = latestFor(true);
    if (mine && mine.price === price && mine.price_max === priceMax && mine.price_text_original === priceTextOriginal) {
      this.db.prepare(`UPDATE kb_product_prices SET last_seen_at = MAX(last_seen_at, ?) WHERE id = ?`).run(capturedAt, mine.id);
      return { outcome: OUTCOME.PUBLISHED, reasons: gate.reasons, priceId: mine.id, touched: true };
    }
    const priceId = this.db
      .prepare(
        `INSERT INTO kb_product_prices (product_id, variant, price, price_max, currency, unit, price_text_original, evidence_id, captured_at, source_published_at, last_seen_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(productId, variant, price, priceMax, currency, unit, priceTextOriginal, gate.evidenceId, capturedAt, publishedAt, capturedAt, gate.outcome).lastInsertRowid;
    const theirs = gate.outcome === OUTCOME.PUBLISHED ? latestFor(false) : null;
    if (theirs && (theirs.price !== price || theirs.price_max !== priceMax) && days(theirs.captured_at, capturedAt) <= PRICE_CONFLICT_WINDOW_DAYS) {
      this._recordConflict("price", `product:${productId}:price:${variant ?? ""}`, "kb_product_prices", [priceId, theirs.id]);
    }
    return { outcome: gate.outcome, reasons: gate.reasons, priceId, price, priceMax };
  }

  // ------------------------------------------------------------------ food ↔ product links

  _foodNameKinds(foodEntityId) {
    return this.db.prepare(`SELECT normalized, kind FROM kb_food_names WHERE entity_id = ? AND status = 'published'`).all(foodEntityId);
  }

  _foodNames(foodEntityId) {
    return this.db.prepare(`SELECT normalized FROM kb_food_names WHERE entity_id = ? AND status = 'published'`).all(foodEntityId).map((r) => r.normalized);
  }

  /**
   * Links a food entity to a merchant product (reference, or an orderable
   * platform product by id). Only an EXACT name match (re-checked here) is
   * published automatically; everything else waits for a person.
   */
  proposeFoodProductLink({ foodKey, kbProductId = null, platformMerchantId = null, platformProductId = null, platformProductName = null, matchType, linkRole = "primary", evidenceId = null, decidedBy = null }) {
    const food = this.k.entity(foodKey);
    if (!food || food.status !== "published") throw new Error(`unknown or unpublished food "${foodKey}"`);
    const product = kbProductId ? this.db.prepare(`SELECT * FROM kb_merchant_products WHERE id = ?`).get(kbProductId) : null;
    if (kbProductId && !product) throw new Error(`unknown product ${kbProductId}`);
    const productName = product ? product.original_name : platformProductName;
    const reasons = [];
    let status = "review";
    if (matchType === "manual") {
      if (!decidedBy) throw new Error("a manual link needs decidedBy");
      status = "published";
    } else if (matchType === "exact") {
      const key = normalizeName(productName ?? "");
      const own = this._foodNameKinds(food.id).filter((n) => n.normalized === key);
      if (productName && own.some((n) => n.kind === "canonical" || n.kind === "no_accent") && (!product || product.status === "published")) status = "published";
      else if (productName && own.length) {
        // equal only to an ALIAS ("Bánh ướt" as an alias of Bánh cuốn): the alias may name a different local dish
        matchType = "alias";
        reasons.push(reason("ALIAS_MATCH", `"${productName}" equals an alias of ${food.canonical_name}, not its name — a person decides`));
      } else reasons.push(reason("NOT_EXACT", `"${productName}" is not exactly a name of ${food.canonical_name}`));
    } else {
      reasons.push(reason("NEEDS_REVIEW", `${matchType} links are decided by a person`));
    }
    const existing = kbProductId
      ? this.db.prepare(`SELECT * FROM kb_food_product_links WHERE food_entity_id = ? AND kb_product_id = ?`).get(food.id, kbProductId)
      : this.db.prepare(`SELECT * FROM kb_food_product_links WHERE food_entity_id = ? AND platform_merchant_id = ? AND platform_product_id = ?`).get(food.id, platformMerchantId, platformProductId);
    if (existing) return { outcome: existing.status, reasons: [reason("ALREADY_EXISTS", "link already proposed")], linkId: existing.id };
    const linkId = this.db
      .prepare(
        `INSERT INTO kb_food_product_links (food_entity_id, kb_product_id, platform_merchant_id, platform_product_id, match_type, link_role, confidence, evidence_id, status, decided_by, review_reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(food.id, kbProductId, platformMerchantId, platformProductId, matchType, linkRole, LINK_CONFIDENCE[matchType], evidenceId ?? product?.evidence_id ?? null, status, decidedBy, reasons.map((r) => r.code).join(",") || null).lastInsertRowid;
    return { outcome: status, reasons, linkId };
  }

  resolveLinkReview({ linkId, approve, decidedBy }) {
    if (!decidedBy) throw new Error("decidedBy is required");
    const link = this.db.prepare(`SELECT * FROM kb_food_product_links WHERE id = ?`).get(linkId);
    if (!link || link.status !== "review") throw new Error(`link ${linkId} is not in review`);
    this.db
      .prepare(`UPDATE kb_food_product_links SET status = ?, decided_by = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(approve ? "published" : "rejected", decidedBy, linkId);
    return this.db.prepare(`SELECT * FROM kb_food_product_links WHERE id = ?`).get(linkId);
  }

  /** The person-made bridge from a reference merchant to an onboarded platform merchant. */
  bridgeMerchant({ kbMerchantId, platformMerchantId, linkedBy, note = null }) {
    if (!linkedBy) throw new Error("linkedBy is required");
    this.db.prepare(`INSERT INTO kb_merchant_links (kb_merchant_id, platform_merchant_id, linked_by, note) VALUES (?, ?, ?, ?)`).run(kbMerchantId, platformMerchantId, linkedBy, note);
    return this.db.prepare(`SELECT * FROM kb_merchant_links WHERE kb_merchant_id = ?`).get(kbMerchantId);
  }
}
