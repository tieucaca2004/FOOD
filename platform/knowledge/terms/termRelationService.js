import { termKey, hasDiacritics, onlyGenericWords, lowerNfc } from "./termNormalize.js";
import { TermMatcher } from "./termMatcher.js";

// Term relations: CANONICAL FOOD -> APPROVED TERMS. Lifecycle DRAFT -> REVIEW -> APPROVED -> RETIRED, with
// provenance (evidence) and versions. An LLM may only PROPOSE; a person approves. A customer message never creates
// a relation (the matcher has no write path). Reads kb_food_entities / kb_regions / kb_region_names; writes only
// kb_term_* (migration 007). Not wired into any runtime path yet.

export const RELATION_TYPES = ["EXACT_ALIAS", "SPELLING_VARIANT", "DIACRITIC_VARIANT", "COMMON_QUERY", "ABBREVIATION", "REGIONAL_ALIAS", "RELATED_TERM", "DISALLOWED_TERM"];
const NAMING_TYPES = new Set(["EXACT_ALIAS", "SPELLING_VARIANT", "DIACRITIC_VARIANT", "COMMON_QUERY", "ABBREVIATION", "REGIONAL_ALIAS"]);
const NAMING_SQL = `('EXACT_ALIAS', 'SPELLING_VARIANT', 'DIACRITIC_VARIANT', 'COMMON_QUERY', 'ABBREVIATION', 'REGIONAL_ALIAS')`;
const PROPOSER_KINDS = ["person", "llm", "rule", "import"];
const DEFAULT_CONFIDENCE = { person: 0.9, rule: 0.8, import: 0.7, llm: 0.5 };
const NON_PERSON = /^(?:ai|model|gpt|llm|bot|system|auto)(?:[:/\s-]|$)/i;

export class TermRelationError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
const fail = (code, message) => {
  throw new TermRelationError(code, message);
};

export class TermRelationService {
  constructor({ db }) {
    this.db = db;
  }

  // ------------------------------------------------------------------ data access (kb_term_* only)
  _row(id) {
    const r = this.db.prepare(`SELECT * FROM kb_term_relations WHERE id = ?`).get(Number(id));
    if (!r) fail("NOT_FOUND", `no term relation #${id}`);
    return r;
  }
  _event(id, action, actor, note = null) {
    this.db.prepare(`INSERT INTO kb_term_events (relation_id, action, actor, note) VALUES (?, ?, ?, ?)`).run(id, action, actor, note);
  }
  _food(id) {
    return this.db.prepare(`SELECT id, canonical_name, normalized_name, status FROM kb_food_entities WHERE id = ?`).get(id) ?? null;
  }
  _regionKeys() {
    const names = [
      ...this.db.prepare(`SELECT name FROM kb_regions`).all().map((r) => r.name),
      ...this.db.prepare(`SELECT name FROM kb_region_names`).all().map((r) => r.name),
    ];
    return new Set(names.map(termKey).filter(Boolean));
  }

  // ------------------------------------------------------------------ proposal (validated)

  /**
   * @param {{foodEntityId?: number|null, term: string, relationType: string, regionId?: string|null, confidence?: number, createdBy: string,
   *          proposedByKind?: "person"|"llm"|"rule"|"import", evidence: {sourceKind, sourceRef, quote}[]}} p
   */
  propose({ foodEntityId = null, term, relationType, regionId = null, confidence = null, createdBy, proposedByKind = "person", evidence = [] }) {
    if (!createdBy) fail("ACTOR_REQUIRED", "createdBy is required");
    if (!PROPOSER_KINDS.includes(proposedByKind)) fail("INVALID_PROPOSER", `proposedByKind is one of ${PROPOSER_KINDS.join(", ")}`);
    if (!RELATION_TYPES.includes(relationType)) fail("INVALID_TYPE", `relationType is one of ${RELATION_TYPES.join(", ")}`);
    const raw = lowerNfc(term).trim().replace(/\s+/g, " ");
    const key = termKey(raw);
    if (!key || key.replace(/ /g, "").length < 2) fail("TERM_TOO_SHORT", "the term is empty or too short");
    if (/^[\d ]+$/.test(key)) fail("TERM_NUMERIC", "a number is not a dish name");
    if (relationType !== "DISALLOWED_TERM" && onlyGenericWords(key)) fail("GENERIC_TERM", `"${term}" is made only of generic words (món, quán, ăn, ngon, giá, còn, đâu, này, kia…) — never a dish name`);
    if (relationType !== "DISALLOWED_TERM" && this._regionKeys().has(key)) fail("GEOGRAPHIC_TERM", `"${term}" is a place — a modifier, never an alias of a dish`);
    // a regional name belongs to a known region; nothing else has one
    if (relationType === "REGIONAL_ALIAS") {
      if (!regionId || !this.db.prepare(`SELECT 1 FROM kb_regions WHERE id = ?`).get(regionId)) fail("UNKNOWN_REGION", "a REGIONAL_ALIAS needs a known region");
    } else if (regionId !== null) fail("REGION_NOT_ALLOWED", "only a REGIONAL_ALIAS has a region");
    let food = null;
    if (foodEntityId !== null) {
      food = this._food(foodEntityId);
      if (!food || food.status !== "published") fail("UNKNOWN_FOOD", `no published canonical dish #${foodEntityId}`);
    } else if (relationType !== "DISALLOWED_TERM") fail("FOOD_REQUIRED", "only a DISALLOWED_TERM may apply to every dish");
    if (food && NAMING_TYPES.has(relationType) && lowerNfc(food.canonical_name) === raw) fail("ALREADY_CANONICAL", "the term is the dish's canonical name");
    if (relationType === "DIACRITIC_VARIANT") {
      if (hasDiacritics(raw)) fail("NOT_A_DIACRITIC_VARIANT", "a diacritic variant is written without accents");
      const namedKeys = new Set([termKey(food.canonical_name), ...this._approvedNamingKeys(food.id)]);
      if (!namedKeys.has(key)) fail("NOT_A_DIACRITIC_VARIANT", "a diacritic variant is the unaccented spelling of the dish's name or an approved alias");
    }
    const c = confidence ?? DEFAULT_CONFIDENCE[proposedByKind];
    if (!(c >= 0 && c <= 1)) fail("INVALID_CONFIDENCE", "confidence is in [0, 1]");
    const id = this.db.transaction(() => {
      const rowId = this.db
        .prepare(`INSERT INTO kb_term_relations (food_entity_id, canonical_name, term, term_key, term_accented, relation_type, region_id, confidence, proposed_by_kind, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(food?.id ?? null, food?.canonical_name ?? null, raw, key, hasDiacritics(raw) ? 1 : 0, relationType, regionId, c, proposedByKind, createdBy).lastInsertRowid;
      this.db.prepare(`UPDATE kb_term_relations SET lineage_id = id WHERE id = ?`).run(rowId);
      this._event(rowId, "proposed", createdBy, proposedByKind === "llm" ? "LLM proposal — needs a person's approval" : null);
      for (const e of evidence) this._link(rowId, e, createdBy);
      return rowId;
    })();
    return this.get(id);
  }

  _approvedNamingKeys(foodId) {
    return this.db.prepare(`SELECT term_key FROM kb_term_relations WHERE food_entity_id = ? AND status = 'APPROVED' AND relation_type IN ('EXACT_ALIAS', 'SPELLING_VARIANT', 'COMMON_QUERY', 'ABBREVIATION', 'REGIONAL_ALIAS')`).all(foodId).map((r) => r.term_key);
  }

  linkEvidence(id, evidence, actor) {
    const r = this._row(id);
    if (!["DRAFT", "REVIEW"].includes(r.status)) fail("NOT_EDITABLE", `evidence is linked before approval (this is ${r.status})`);
    this.db.transaction(() => this._link(id, evidence, actor))();
    return this.get(id);
  }

  _link(id, { sourceKind, sourceRef, quote }, actor) {
    if (!["founder_item", "kb_evidence", "ingest_message", "text"].includes(sourceKind)) fail("INVALID_SOURCE", "unknown evidence source kind");
    if (!String(sourceRef ?? "").trim() || !String(quote ?? "").trim()) fail("EVIDENCE_INCOMPLETE", "evidence needs a source and a verbatim quote");
    const exists = {
      founder_item: () => this.db.prepare(`SELECT 1 FROM sqlite_master WHERE name = 'kb_founder_items'`).get() && this.db.prepare(`SELECT 1 FROM kb_founder_items WHERE id = ?`).get(Number(sourceRef)),
      kb_evidence: () => this.db.prepare(`SELECT 1 FROM kb_evidence WHERE id = ?`).get(Number(sourceRef)),
      ingest_message: () => this.db.prepare(`SELECT 1 FROM sqlite_master WHERE name = 'kb_ingest_messages'`).get() && this.db.prepare(`SELECT 1 FROM kb_ingest_messages WHERE id = ?`).get(Number(sourceRef)),
      text: () => /^[0-9a-f]{64}$/.test(String(sourceRef)),
    }[sourceKind]();
    if (!exists) fail("UNKNOWN_SOURCE", `no ${sourceKind} ${sourceRef}`);
    this.db.prepare(`INSERT INTO kb_term_evidence (relation_id, source_kind, source_ref, quote) VALUES (?, ?, ?, ?)`).run(id, sourceKind, String(sourceRef), String(quote).trim());
    this._event(id, "evidence_linked", actor, `${sourceKind} ${sourceRef}`);
  }

  // ------------------------------------------------------------------ lifecycle

  submitForReview(id, actor) {
    const r = this._row(id);
    if (r.status !== "DRAFT") fail("INVALID_TRANSITION", `${r.status} -> REVIEW is not allowed`);
    if (!this._evidence(id).length) fail("EVIDENCE_REQUIRED", "a relation needs evidence before review");
    this.db.transaction(() => {
      this.db.prepare(`UPDATE kb_term_relations SET status = 'REVIEW', updated_at = datetime('now') WHERE id = ? AND status = 'DRAFT'`).run(id);
      this._event(id, "submitted", actor);
    })();
    return this.get(id);
  }

  returnToDraft(id, actor, note = null) {
    const r = this._row(id);
    if (r.status !== "REVIEW") fail("INVALID_TRANSITION", `${r.status} -> DRAFT is not allowed`);
    this.db.transaction(() => {
      this.db.prepare(`UPDATE kb_term_relations SET status = 'DRAFT', updated_at = datetime('now') WHERE id = ? AND status = 'REVIEW'`).run(id);
      this._event(id, "returned", actor, note);
    })();
    return this.get(id);
  }

  /** A person approves. A term that already names ANOTHER dish needs ackAmbiguous (it becomes ambiguous, by design). */
  approve(id, { by, ackAmbiguous = false, note = null }) {
    if (!by || NON_PERSON.test(String(by).trim())) fail("PERSON_REQUIRED", "approval is a person's decision (not an AI / system actor)");
    const r = this._row(id);
    if (r.status !== "REVIEW") fail("INVALID_TRANSITION", `${r.status} -> APPROVED is not allowed (submit it for review first)`);
    if (NAMING_TYPES.has(r.relation_type)) {
      const others = this.db
        .prepare(`SELECT DISTINCT food_entity_id FROM kb_term_relations WHERE term_key = ? AND status = 'APPROVED' AND food_entity_id != ? AND relation_type IN ${NAMING_SQL}`)
        .all(r.term_key, r.food_entity_id)
        .map((x) => x.food_entity_id);
      const canonicalOthers = this.db.prepare(`SELECT id FROM kb_food_entities WHERE status = 'published' AND id != ?`).all(r.food_entity_id).filter((f) => termKey(this._food(f.id).canonical_name) === r.term_key).map((f) => f.id);
      const clash = [...new Set([...others, ...canonicalOthers])];
      if (clash.length && !ackAmbiguous) fail("AMBIGUOUS_TERM", `"${r.term}" already names dish(es) #${clash.join(", #")} — approving makes it ambiguous (the matcher will ask); acknowledge to approve`);
    }
    this.db.transaction(() => {
      const current = this.db.prepare(`SELECT id FROM kb_term_relations WHERE lineage_id = ? AND status = 'APPROVED'`).get(r.lineage_id);
      if (current && current.id !== r.id) {
        this.db.prepare(`UPDATE kb_term_relations SET status = 'RETIRED', retired_by = ?, retired_at = datetime('now'), retired_reason = ?, updated_at = datetime('now') WHERE id = ?`).run(by, `superseded by #${r.id} (v${r.version})`, current.id);
        this._event(current.id, "retired", by, `superseded by #${r.id}`);
      }
      this.db.prepare(`UPDATE kb_term_relations SET status = 'APPROVED', approved_by = ?, approved_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND status = 'REVIEW'`).run(by, r.id);
      this._event(r.id, "approved", by, note);
    })();
    return this.get(id);
  }

  retire(id, { by, reason }) {
    if (!by || !String(reason ?? "").trim()) fail("REASON_REQUIRED", "who retires it and why are required");
    const r = this._row(id);
    if (r.status === "RETIRED") fail("INVALID_TRANSITION", "already RETIRED");
    this.db.transaction(() => {
      this.db.prepare(`UPDATE kb_term_relations SET status = 'RETIRED', retired_by = ?, retired_at = datetime('now'), retired_reason = ?, updated_at = datetime('now') WHERE id = ?`).run(by, reason, id);
      this._event(id, "retired", by, reason);
    })();
    return this.get(id);
  }

  /** A new version (e.g. another relation type or confidence) — the approved one stays until the new one is approved. */
  revise(id, { relationType, confidence }, createdBy) {
    const base = this._row(id);
    if (!["APPROVED", "RETIRED"].includes(base.status)) fail("INVALID_TRANSITION", "revise an APPROVED or RETIRED relation");
    const type = relationType ?? base.relation_type;
    if (!RELATION_TYPES.includes(type)) fail("INVALID_TYPE", "unknown relation type");
    if (type === "REGIONAL_ALIAS" && !base.region_id) fail("UNKNOWN_REGION", "a REGIONAL_ALIAS needs a region: propose it anew");
    const newId = this.db.transaction(() => {
      const version = this.db.prepare(`SELECT MAX(version) AS v FROM kb_term_relations WHERE lineage_id = ?`).get(base.lineage_id).v + 1;
      const rowId = this.db
        .prepare(`INSERT INTO kb_term_relations (lineage_id, version, supersedes_id, food_entity_id, canonical_name, term, term_key, term_accented, relation_type, region_id, confidence, proposed_by_kind, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'person', ?)`)
        .run(base.lineage_id, version, base.id, base.food_entity_id, base.canonical_name, base.term, base.term_key, base.term_accented, type, type === "REGIONAL_ALIAS" ? base.region_id : null, confidence ?? base.confidence, createdBy).lastInsertRowid;
      this._event(rowId, "proposed", createdBy, `new version of #${base.id}`);
      for (const e of this._evidence(base.id)) this.db.prepare(`INSERT INTO kb_term_evidence (relation_id, source_kind, source_ref, quote) VALUES (?, ?, ?, ?)`).run(rowId, e.source_kind, e.source_ref, e.quote);
      return rowId;
    })();
    return this.get(newId);
  }

  // ------------------------------------------------------------------ reads

  _evidence(id) {
    return this.db.prepare(`SELECT source_kind, source_ref, quote, created_at FROM kb_term_evidence WHERE relation_id = ? ORDER BY id`).all(id);
  }

  get(id) {
    const r = this._row(id);
    return { ...r, evidence: this._evidence(r.id), events: this.db.prepare(`SELECT action, actor, note, at FROM kb_term_events WHERE relation_id = ? ORDER BY id`).all(r.id) };
  }

  list({ status = null, foodEntityId = null } = {}) {
    return this.db
      .prepare(`SELECT * FROM kb_term_relations WHERE (? IS NULL OR status = ?) AND (? IS NULL OR food_entity_id = ?) ORDER BY lineage_id, version`)
      .all(status, status, foodEntityId, foodEntityId);
  }

  /** A matcher over what is in force: published canonical dishes + APPROVED relations only. */
  buildMatcher() {
    const canonicals = this.db.prepare(`SELECT id AS foodEntityId, canonical_name AS canonicalName FROM kb_food_entities WHERE status = 'published'`).all();
    const relations = this.db.prepare(`SELECT * FROM kb_term_relations WHERE status = 'APPROVED'`).all();
    const regions = this.db.prepare(`SELECT id, name, parent_id FROM kb_regions`).all();
    const regionNames = [...regions.map((r) => ({ regionId: r.id, name: r.name })), ...this.db.prepare(`SELECT region_id AS regionId, name FROM kb_region_names`).all()];
    return new TermMatcher({ canonicals, relations, regions, regionNames });
  }
}
