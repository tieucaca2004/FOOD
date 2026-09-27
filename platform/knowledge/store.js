import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { FoodTaxonomy } from "./taxonomy.js";
import { FoodVocabulary } from "./vocabulary.js";
import { rawToText, normalizeName, fold, nfc, hasDiacritics, collapseWhitespace } from "./text.js";
import { pdfToText } from "./pdfText.js";
import { computeConfidence } from "./confidence.js";
import { OUTCOME, checkEvidence, checkStructure, checkSupport, mentionsEntity, quoteNamesIt, decide } from "./validator.js";

// FoodKnowledge store: the ONLY writer of knowledge.db. Every write is a
// PROPOSAL that the validator decides (published / review / rejected);
// nothing a collector or model sends is taken on trust — not the source
// hash, not the confidence, not the status. The founder only decides the
// cases the validator sends to review (resolveReview).
//
// This module never touches the platform DB, merchant_products or menus.

// Support failures that are hard: evidence that only speaks of an
// excluded concept can never become a claim.
const HARD_SUPPORT_CODES = new Set(["OUT_OF_SCOPE_ONLY"]);

function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function domainOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

export class KnowledgeStore {
  /**
   * @param {object} deps
   * @param {import("better-sqlite3").Database} deps.db a knowledge.db connection (migrated)
   * @param {string} [deps.rawRoot] base directory raw_path values are relative to
   */
  constructor({ db, rawRoot = ".", taxonomy = new FoodTaxonomy(), vocabulary = null }) {
    this.db = db;
    this.rawRoot = rawRoot;
    this.taxonomy = taxonomy;
    this.vocabulary = vocabulary ?? new FoodVocabulary(undefined, taxonomy);
  }

  // ------------------------------------------------------------------ regions / sources

  /** A region, with the other ways it is written (`names`: "Sài Gòn", "Nam Vang"…). */
  registerRegion({ id, name, parentId = null, level, validFrom = null, validTo = null, names = [] }) {
    this.db
      .prepare(
        `INSERT INTO kb_regions (id, name, parent_id, level, valid_from, valid_to) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, parent_id = excluded.parent_id, level = excluded.level,
           valid_from = excluded.valid_from, valid_to = excluded.valid_to`
      )
      .run(id, name, parentId, level, validFrom, validTo);
    const insertName = this.db.prepare(`INSERT OR IGNORE INTO kb_region_names (region_id, name, normalized) VALUES (?, ?, ?)`);
    for (const n of [name, ...names]) insertName.run(id, nfc(n).trim(), normalizeName(n));
    return this.db.prepare(`SELECT * FROM kb_regions WHERE id = ?`).get(id);
  }

  /** Every written form of a region (its name first). */
  regionNames(id) {
    const region = this.db.prepare(`SELECT name FROM kb_regions WHERE id = ?`).get(id);
    if (!region) return [];
    const others = this.db.prepare(`SELECT name FROM kb_region_names WHERE region_id = ? ORDER BY id`).all(id).map((r) => r.name);
    return [...new Set([region.name, ...others])];
  }

  /**
   * Registers a stored raw source. The content hash is computed HERE from the
   * raw file; OSM sources must declare the ODbL license and attribution.
   */
  registerSource({ url, sourceType, rawPath, contentType, fetchedAt, publishedAt = null, license = null, attribution = null, robotsAllowed = null }) {
    const type = this.taxonomy.sourceType(sourceType);
    if (!type) throw new Error(`unknown source type "${sourceType}"`);
    if (type.requires_license && (license !== type.requires_license || !attribution)) {
      throw new Error(`${sourceType} sources require license ${type.requires_license} and an attribution`);
    }
    if (!url || !fetchedAt || !contentType) throw new Error("url, fetchedAt and contentType are required");
    const file = path.resolve(this.rawRoot, rawPath);
    if (!fs.existsSync(file)) throw new Error(`raw file not found: ${rawPath}`);
    const hash = sha256File(file);
    this.db
      .prepare(
        `INSERT OR IGNORE INTO kb_sources (url, domain, source_type, license, attribution, fetched_at, source_published_at, content_type, content_hash, raw_path, robots_allowed)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(url, domainOf(url), sourceType, license, attribution, fetchedAt, publishedAt, contentType, hash, rawPath, robotsAllowed === null ? null : robotsAllowed ? 1 : 0);
    return this.db.prepare(`SELECT * FROM kb_sources WHERE url = ? AND content_hash = ?`).get(url, hash);
  }

  // The stored raw copy as the validator sees it: readable text, plus the
  // parsed document for JSON sources (JSON-pointer evidence). Cached per
  // source while the file is unchanged.
  _raw(source) {
    const file = path.resolve(this.rawRoot, source.raw_path);
    if (!fs.existsSync(file)) return { missing: true, hashMatches: false, text: null };
    const stat = fs.statSync(file);
    const cacheKey = `${source.id}:${stat.size}:${stat.mtimeMs}`;
    this._rawCache ??= new Map();
    if (this._rawCache.has(cacheKey)) return this._rawCache.get(cacheKey);
    const hashMatches = sha256File(file) === source.content_hash;
    // a PDF is read as bytes (its text layer); everything else as UTF-8 text
    const isPdf = String(source.content_type).startsWith("application/pdf");
    const content = hashMatches ? (isPdf ? fs.readFileSync(file) : fs.readFileSync(file, "utf8")) : null;
    const pdfText = isPdf && content !== null ? pdfToText(content) : null;
    const result = { missing: false, hashMatches, text: content === null ? null : isPdf ? (pdfText === null ? null : collapseWhitespace(pdfText)) : rawToText(content, source.content_type) };
    if (content !== null && String(source.content_type).startsWith("application/json")) {
      try {
        result.json = JSON.parse(content);
      } catch {
        result.text = null;
      }
    }
    this._rawCache.set(cacheKey, result);
    return result;
  }

  /** Validator view of one piece of evidence: hard/soft failures, the raw text and the quote position. */
  verifyEvidence(evidence) {
    const source = this._source(evidence?.sourceId);
    const raw = source ? this._raw(source) : { missing: false, hashMatches: true, text: null };
    const result = checkEvidence({ evidence, source, raw });
    return { ...result, source, raw };
  }

  insertEvidence(evidence, source, verification) {
    return this._insertEvidence(evidence, source, verification);
  }

  verificationOf(hard, soft) {
    return this._verification(hard, soft);
  }

  _source(id) {
    return id ? this.db.prepare(`SELECT * FROM kb_sources WHERE id = ?`).get(id) || null : null;
  }

  _insertEvidence(evidence, source, verification) {
    const { lastInsertRowid } = this.db
      .prepare(
        `INSERT INTO kb_evidence (source_id, quote, locator, extraction, proposed_by, verification, verification_error, verified_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, CASE WHEN ? = 'verified' THEN datetime('now') END)`
      )
      .run(source.id, evidence.quote, evidence.locator ?? null, evidence.extraction ?? "explicit", evidence.proposedBy ?? null, verification.status, verification.error, verification.status);
    return lastInsertRowid;
  }

  // ------------------------------------------------------------------ entities / names

  entity(key) {
    return this.db.prepare(`SELECT * FROM kb_food_entities WHERE key = ?`).get(key) || null;
  }

  names(entityId, { includeUnpublished = true } = {}) {
    const rows = this.db.prepare(`SELECT * FROM kb_food_names WHERE entity_id = ?`).all(entityId);
    return rows.filter((r) => includeUnpublished ? r.status !== "rejected" : r.status === "published");
  }

  /**
   * A new food entity, evidenced by a quote that names it. Published as soon
   * as the evidence verifies; its unaccented search form is derived.
   */
  proposeEntity({ key, canonicalName, evidence }) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(key || "")) throw new Error(`invalid entity key "${key}"`);
    if (this.entity(key)) throw new Error(`entity "${key}" already exists`);
    const name = nfc(canonicalName).trim();
    const { lastInsertRowid: entityId } = this.db
      .prepare(`INSERT INTO kb_food_entities (key, canonical_name, normalized_name, status) VALUES (?, ?, ?, 'draft')`)
      .run(key, name, normalizeName(name));
    const result = this._proposeName({ entityId, name, kind: "canonical", evidence });
    const status = result.outcome === OUTCOME.PUBLISHED ? "published" : result.outcome === OUTCOME.REVIEW ? "review" : "rejected";
    this.db.prepare(`UPDATE kb_food_entities SET status = ?, updated_at = datetime('now') WHERE id = ?`).run(status, entityId);
    if (status === "published") this._deriveNoAccent(entityId, name);
    return { entity: this.entity(key), ...result };
  }

  proposeName({ entityKey, name, kind, regionId = null, evidence = null }) {
    const entity = this.entity(entityKey);
    if (!entity) throw new Error(`unknown entity "${entityKey}"`);
    return this._proposeName({ entityId: entity.id, name: nfc(name).trim(), kind, regionId, evidence });
  }

  _proposeName({ entityId, name, kind, regionId = null, evidence }) {
    const hard = [];
    const soft = [];
    if (!this.taxonomy.json.name_kinds.includes(kind) || kind === "no_accent") hard.push({ code: "INVALID_KIND", message: `names of kind "${kind}" cannot be proposed` });
    if (regionId && !this._regionExists(regionId)) hard.push({ code: "UNKNOWN_REGION", message: `unknown region "${regionId}"` });
    const source = this._source(evidence?.sourceId);
    const ev = source ? checkEvidence({ evidence, source, raw: this._raw(source) }) : checkEvidence({ evidence, source: null, raw: {} });
    hard.push(...ev.hard);
    soft.push(...ev.soft);
    if (!hard.length && !quoteNamesIt(evidence.quote, name)) soft.push({ code: "NOT_SUPPORTED_BY_QUOTE", message: `the quote does not contain "${name}"` });
    if (kind === "misspelling") soft.push({ code: "NEEDS_FOUNDER_RULE", message: "misspellings are accepted on review" });
    // a kind that can never be proposed is refused without a record
    if (hard.some((r) => r.code === "INVALID_KIND")) return { outcome: OUTCOME.REJECTED, reasons: hard, nameId: null };
    const existing = this.db.prepare(`SELECT * FROM kb_food_names WHERE entity_id = ? AND normalized = ? AND kind = ?`).get(entityId, normalizeName(name), kind);
    if (existing && existing.status !== "rejected") {
      return { outcome: existing.status, reasons: [{ code: "ALREADY_EXISTS", message: "same name already proposed" }], nameId: existing.id };
    }
    const outcome = decide(hard, soft);
    const evidenceId = source && evidence?.quote ? this._insertEvidence(evidence, source, this._verification(hard, soft)) : null;
    const status = outcome === OUTCOME.PUBLISHED ? "published" : outcome === OUTCOME.REVIEW ? "review" : "rejected";
    const reasons = [...hard, ...soft];
    const reasonCodes = reasons.map((r) => r.code).join(",") || null;
    if (existing) {
      // a new attempt for a previously rejected name reuses its row (the old evidence stays in kb_evidence)
      this.db
        .prepare(`UPDATE kb_food_names SET name = ?, region_id = ?, origin = 'sourced', evidence_id = ?, status = ?, review_reason = ? WHERE id = ?`)
        .run(name, regionId, evidenceId, status, reasonCodes, existing.id);
      return { outcome, reasons, nameId: existing.id };
    }
    const { lastInsertRowid } = this.db
      .prepare(`INSERT INTO kb_food_names (entity_id, name, normalized, kind, region_id, origin, evidence_id, status, review_reason) VALUES (?, ?, ?, ?, ?, 'sourced', ?, ?, ?)`)
      .run(entityId, name, normalizeName(name), kind, regionId, evidenceId, status, reasonCodes);
    return { outcome, reasons, nameId: lastInsertRowid };
  }

  // The unaccented spelling is a transformation of the name, not a fact.
  _deriveNoAccent(entityId, name) {
    const plain = fold(name).folded;
    if (!hasDiacritics(name)) return;
    this.db
      .prepare(`INSERT OR IGNORE INTO kb_food_names (entity_id, name, normalized, kind, origin, status) VALUES (?, ?, ?, 'no_accent', 'derived', 'published')`)
      .run(entityId, plain, normalizeName(plain));
  }

  // ------------------------------------------------------------------ claims

  /**
   * @param {object} p {entityKey, kind, key, value?, level?, necessity?, scope?, regionId?,
   *                    evidence: {sourceId, sourceUrl?, quote, locator?, extraction, proposedBy?}}
   *   Any `confidence`/`status` on the proposal is ignored.
   * @returns {{outcome, reasons, claimId}}
   */
  proposeClaim(p) {
    const entity = this.entity(p.entityKey);
    if (!entity) throw new Error(`unknown entity "${p.entityKey}"`);
    const claim = {
      kind: p.kind,
      key: p.key,
      value: p.value ?? null,
      level: p.level ?? null,
      necessity: p.necessity ?? null,
      scope: p.scope ?? "typical",
      regionId: p.regionId ?? null,
    };
    const related = p.kind === "relation" && this.taxonomy.relation(p.key)?.target === "entity" ? this.entity(claim.value) : null;

    const hard = checkStructure(this.taxonomy, claim, {
      regionExists: (id) => this._regionExists(id),
      relatedEntityExists: (k) => Boolean(this.entity(k)),
    });
    const source = this._source(p.evidence?.sourceId);
    const raw = source ? this._raw(source) : { missing: false, hashMatches: true, text: null };
    const ev = hard.length ? { hard: [], soft: [], at: -1 } : checkEvidence({ evidence: p.evidence, source, raw });
    hard.push(...ev.hard);
    const soft = [...ev.soft];

    if (!hard.length && raw.text !== null) {
      const support = checkSupport(claim, p.evidence.quote, {
        taxonomy: this.taxonomy,
        vocabulary: this.vocabulary,
        relatedNames: related ? this.names(related.id).map((n) => n.name) : [],
        regionNames: this.taxonomy.relation(claim.key)?.target === "region" ? this.regionNames(claim.value) : null,
      });
      for (const r of support) (HARD_SUPPORT_CODES.has(r.code) ? hard : soft).push(r);
      const names = this.names(entity.id).map((n) => n.name);
      if (!hard.length && !mentionsEntity({ quote: p.evidence.quote, rawText: raw.text, at: ev.at, names })) {
        soft.push({ code: "ENTITY_NOT_MENTIONED", message: `neither the quote nor the text around it names ${entity.canonical_name}` });
      }
    }
    if (!hard.length && entity.status !== "published") soft.push({ code: "ENTITY_NOT_PUBLISHED", message: "the entity itself is not published yet" });

    // Idempotent: the same claim from the same quote of the same source is the
    // same proposal (a rejected attempt stays on record but does not block a corrected one).
    const existing = this._sameProposal(entity.id, claim, source, p.evidence);
    if (existing) return { outcome: existing.status, reasons: [{ code: "ALREADY_EXISTS", message: "same claim already proposed from this evidence" }], claimId: existing.id };

    const conflicting = !hard.length ? this._conflicts(entity.id, claim) : [];
    if (conflicting.length) soft.push({ code: "CONFLICT", message: `published evidence says otherwise (claims ${conflicting.map((c) => c.id).join(", ")})` });

    if (!source || !String(p.evidence?.quote ?? "").trim()) {
      // nothing to store as evidence: the proposal is refused outright
      return { outcome: OUTCOME.REJECTED, reasons: hard, claimId: null };
    }
    const outcome = decide(hard, soft);
    const evidenceId = this._insertEvidence(p.evidence, source, this._verification(hard, soft));
    const reasons = [...hard, ...soft];
    const { lastInsertRowid: claimId } = this.db
      .prepare(
        `INSERT INTO kb_claims (entity_id, kind, key, value, level, necessity, scope, region_id, related_entity_id, evidence_id, status, review_reason, conflict)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(entity.id, claim.kind, claim.key, claim.value, claim.level, claim.necessity, claim.scope, claim.regionId, related?.id ?? null, evidenceId, outcome, reasons.map((r) => r.code).join(",") || null, conflicting.length ? 1 : 0);
    if (conflicting.length) {
      this.db.prepare(`UPDATE kb_claims SET conflict = 1, updated_at = datetime('now') WHERE id IN (${conflicting.map(() => "?").join(",")})`).run(...conflicting.map((c) => c.id));
      // published evidence that is now contested loses confidence right away
      for (const c of conflicting) this._recomputeConfidence(entity.id, { kind: c.kind, key: c.key, value: c.value, level: c.level, scope: c.scope, regionId: c.region_id });
    }
    if (outcome === OUTCOME.PUBLISHED) this._recomputeConfidence(entity.id, claim);
    return { outcome, reasons, claimId };
  }

  _verification(hard, soft) {
    const failed = hard.find((r) => ["QUOTE_NOT_FOUND", "RAW_MISSING", "RAW_CHANGED", "SOURCE_URL_MISMATCH", "MISSING_SOURCE_URL"].includes(r.code));
    if (failed) return { status: "failed", error: failed.code };
    if (hard.length || soft.some((r) => r.code === "UNSUPPORTED_RAW_TYPE")) return { status: "pending", error: null };
    return { status: "verified", error: null };
  }

  _regionExists(id) {
    return Boolean(this.db.prepare(`SELECT 1 FROM kb_regions WHERE id = ?`).get(id));
  }

  // The "slot" a claim fills: same entity, kind, key, scope and region. `a` is a table alias prefix.
  _slotWhere(entityId, claim, a = "") {
    return {
      sql: `${a}entity_id = ? AND ${a}kind = ? AND ${a}key = ? AND ${a}scope = ? AND ${a}region_id IS ?`,
      params: [entityId, claim.kind, claim.key, claim.scope, claim.regionId],
    };
  }

  _sameProposal(entityId, claim, source, evidence) {
    if (!source || !evidence?.quote) return null;
    const slot = this._slotWhere(entityId, claim, "c.");
    return (
      this.db
        .prepare(
          // the same page (by URL, whatever snapshot of it) saying the same thing is the same observation
          `SELECT c.* FROM kb_claims c JOIN kb_evidence e ON e.id = c.evidence_id JOIN kb_sources s ON s.id = e.source_id
           WHERE ${slot.sql} AND c.value IS ? AND c.level IS ? AND s.url = ? AND e.quote = ? AND c.status != 'rejected'`
        )
        .get(...slot.params, claim.value, claim.level, source.url, evidence.quote) || null
    );
  }

  // Only single-valued slots conflict: an attribute (one serving temperature,
  // one spice level) or the completeness of an ingredient list. Facets are
  // multi-valued (breakfast AND lunch), ingredients are additive.
  _conflicts(entityId, claim) {
    if (!["attribute", "ingredient_completeness"].includes(claim.kind)) return [];
    const slot = this._slotWhere(entityId, claim);
    return this.db
      .prepare(`SELECT * FROM kb_claims WHERE ${slot.sql} AND status = 'published' AND (value IS NOT ? OR level IS NOT ?)`)
      .all(...slot.params, claim.value, claim.level);
  }

  // Every published claim agreeing on this slot+value shares one confidence,
  // raised by each additional independent domain.
  _recomputeConfidence(entityId, claim) {
    const slot = this._slotWhere(entityId, claim, "c.");
    const group = this.db
      .prepare(
        `SELECT c.id, c.conflict, s.source_type, s.domain, e.extraction FROM kb_claims c
         JOIN kb_evidence e ON e.id = c.evidence_id JOIN kb_sources s ON s.id = e.source_id
         WHERE ${slot.sql} AND c.value IS ? AND c.level IS ? AND c.status = 'published'`
      )
      .all(...slot.params, claim.value, claim.level);
    const domains = new Set(group.map((g) => g.domain || `source-${g.id}`)).size;
    const update = this.db.prepare(`UPDATE kb_claims SET confidence = ?, updated_at = datetime('now') WHERE id = ?`);
    for (const g of group) {
      update.run(computeConfidence(this.taxonomy, { sourceType: g.source_type, extraction: g.extraction, independentDomains: domains, conflict: Boolean(g.conflict) }), g.id);
    }
  }

  // ------------------------------------------------------------------ review (founder)

  listReview() {
    return {
      entities: this.db.prepare(`SELECT * FROM kb_food_entities WHERE status = 'review' ORDER BY id`).all(),
      names: this.db.prepare(`SELECT * FROM kb_food_names WHERE status = 'review' ORDER BY id`).all(),
      claims: this.db.prepare(`SELECT * FROM kb_claims WHERE status = 'review' ORDER BY id`).all(),
      foodDuplicates: this.db.prepare(`SELECT * FROM kb_food_duplicate_candidates WHERE status = 'pending' ORDER BY id`).all(),
    };
  }

  /**
   * The founder's decision on a review case. Only a proposal whose evidence
   * is real (quote verified in its raw source) can be approved — rejected
   * proposals stay rejected.
   */
  resolveReview({ type, id, approve, decidedBy, note = null }) {
    if (!decidedBy) throw new Error("decidedBy is required");
    const table = { entity: "kb_food_entities", name: "kb_food_names", claim: "kb_claims" }[type];
    if (!table) throw new Error(`unknown review type "${type}"`);
    const row = this.db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
    if (!row) throw new Error(`${type} ${id} not found`);
    if (row.status !== "review") throw new Error(`${type} ${id} is ${row.status}, not in review`);
    const evidenceId = type === "entity" ? this.db.prepare(`SELECT evidence_id FROM kb_food_names WHERE entity_id = ? AND kind = 'canonical'`).get(id)?.evidence_id : row.evidence_id;
    const evidence = evidenceId ? this.db.prepare(`SELECT * FROM kb_evidence WHERE id = ?`).get(evidenceId) : null;
    // the validator must have verified the quote in its raw source first — a review decides meaning, never evidence
    if (approve && evidence?.verification !== "verified") throw new Error(`${type} ${id} has no verified evidence and cannot be approved`);
    const status = approve ? "published" : "rejected";
    const decision = `${approve ? "approved" : "rejected"} by ${decidedBy}${note ? `: ${note}` : ""}`;
    if (type === "entity") {
      this.db.prepare(`UPDATE kb_food_entities SET status = ?, updated_at = datetime('now') WHERE id = ?`).run(status, id);
      this.db.prepare(`UPDATE kb_food_names SET status = ?, review_reason = ? WHERE entity_id = ? AND kind = 'canonical' AND status = 'review'`).run(status, decision, id);
      if (approve) this._deriveNoAccent(id, row.canonical_name);
    } else if (type === "name") {
      this.db.prepare(`UPDATE kb_food_names SET status = ?, review_reason = ? WHERE id = ?`).run(status, decision, id);
    } else {
      this.db.prepare(`UPDATE kb_claims SET status = ?, review_reason = ?, updated_at = datetime('now') WHERE id = ?`).run(status, decision, id);
      if (approve) {
        const claim = { kind: row.kind, key: row.key, value: row.value, level: row.level, scope: row.scope, regionId: row.region_id };
        this._recomputeConfidence(row.entity_id, claim);
      }
    }
    return this.db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
  }

  // ------------------------------------------------------------------ food duplicate / variant candidates

  /** Records that two entities' names overlap. Never merges; idempotent per pair. */
  proposeFoodDuplicate({ entityA, entityB, kind, signals, score = null }) {
    const [a, b] = entityA < entityB ? [entityA, entityB] : [entityB, entityA];
    if (a === b) throw new Error("a duplicate candidate needs two different entities");
    const info = this.db
      .prepare(`INSERT OR IGNORE INTO kb_food_duplicate_candidates (entity_a, entity_b, kind, signals_json, score) VALUES (?, ?, ?, ?, ?)`)
      .run(a, b, kind, JSON.stringify(signals), score);
    return { created: info.changes > 0, row: this.db.prepare(`SELECT * FROM kb_food_duplicate_candidates WHERE entity_a = ? AND entity_b = ?`).get(a, b) };
  }

  /** A person's decision on a pair: same_dish | variant | distinct. Nothing is merged automatically even then. */
  resolveFoodDuplicate({ id, decision, decidedBy }) {
    if (!decidedBy) throw new Error("decidedBy is required");
    if (!["same_dish", "variant", "distinct"].includes(decision)) throw new Error(`unknown decision "${decision}"`);
    const row = this.db.prepare(`SELECT * FROM kb_food_duplicate_candidates WHERE id = ?`).get(id);
    if (!row || row.status !== "pending") throw new Error(`food duplicate candidate ${id} is not pending`);
    this.db.prepare(`UPDATE kb_food_duplicate_candidates SET status = ?, decided_by = ?, decided_at = datetime('now') WHERE id = ?`).run(decision, decidedBy, id);
    return this.db.prepare(`SELECT * FROM kb_food_duplicate_candidates WHERE id = ?`).get(id);
  }

  // ------------------------------------------------------------------ read (published only)

  publishedClaims(entityKey) {
    return this.db.prepare(`SELECT * FROM kb_published_claims WHERE entity_key = ? ORDER BY kind, key, id`).all(entityKey);
  }

  publishedNames(entityKey) {
    return this.db.prepare(`SELECT * FROM kb_published_names WHERE entity_key = ? ORDER BY kind, id`).all(entityKey);
  }
}
