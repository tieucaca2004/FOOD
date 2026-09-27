import fs from "node:fs";
import path from "node:path";
import { detectChange, confidenceOf } from "./changes.js";
import { normalizeName } from "../text.js";

// Customer contributions: the KnowledgeSubmission lifecycle on top of KnowledgeIngestion.
//
//   RECEIVED -> EXTRACTING -> WAITING_FOR_MERCHANT | WAITING_FOR_CONFIRMATION -> CANDIDATE -> CLOSED
//                          -> NO_CONTENT | FAILED            open -> CANCELLED       waiting -> EXPIRED
//
// The pending state lives on the submission row (never in the platform session or the ordering state); the DB
// triggers of migration 008 enforce the transitions, the privacy of message rows and "no candidate before the
// customer confirmed". A customer's evidence (message, media, OCR text) is kept whatever happens; candidates are
// PROPOSALS for review and are shown to anyone only as USER_CONTRIBUTED_UNVERIFIED_EVIDENCE.

export const OPEN_STATES = ["RECEIVED", "EXTRACTING", "WAITING_FOR_MERCHANT", "WAITING_FOR_CONFIRMATION"];
export const WAITING_STATES = ["WAITING_FOR_MERCHANT", "WAITING_FOR_CONFIRMATION"];
export const PENDING_TTL_MS = 30 * 60_000;
// how long a candidate may be shown (read-time expiry; the row itself is never changed)
export const FIELD_TTL_DAYS = { price: 90, product: 180, availability: 60, opening_hours: 180, address: 365, place: 365, dish: 180 };
const MAX_VISIBLE = 5;
const fieldOf = (f) => (f.kind === "price" ? "price" : f.kind === "availability" ? "availability" : f.kind);
// a phone / account number read as an amount is personal data, never a price candidate
const PHONE_LIKE = /^\+?\d[\d .-]{8,}\d$/;
const PLAUSIBLE_PRICE = (v) => {
  const [a, b] = String(v ?? "").split("-").map(Number);
  return Number.isFinite(a) && a >= 1000 && (b === undefined || (Number.isFinite(b) && b <= 20_000_000)) && a <= 20_000_000;
};

export class ContributionStore {
  /**
   * @param {{db: import("better-sqlite3").Database, ingestion: import("./ingestion.js").KnowledgeIngestion, now?: () => Date, pendingTtlMs?: number}} deps
   */
  constructor({ db, ingestion, now = () => new Date(), pendingTtlMs = PENDING_TTL_MS }) {
    this.db = db;
    this.ingestion = ingestion;
    this.now = now;
    this.pendingTtlMs = pendingTtlMs;
  }

  _iso(offsetMs = 0) {
    return new Date(this.now().getTime() + offsetMs).toISOString();
  }

  // ------------------------------------------------------------------ submissions

  get(id) {
    const s = this.db.prepare(`SELECT * FROM kb_ingest_submissions WHERE id = ?`).get(id);
    return s ? { ...s, place_resolution: s.place_resolution ? JSON.parse(s.place_resolution) : null } : null;
  }

  /** Waiting submissions whose time is up become EXPIRED (their evidence stays). Lazy: run before every lookup. */
  expireStale() {
    const nowIso = this._iso();
    const stale = this.db.prepare(`SELECT id, status FROM kb_ingest_submissions WHERE status IN ('WAITING_FOR_MERCHANT', 'WAITING_FOR_CONFIRMATION') AND expires_at <= ?`).all(nowIso);
    for (const s of stale) this.transition(s.id, "EXPIRED", { actor: "system", reason: "pending_ttl" });
    return stale.length;
  }

  /** The person's open submission on this channel, or null. */
  open(channel, senderHash) {
    this.expireStale();
    const row = this.db.prepare(`SELECT id FROM kb_ingest_submissions WHERE channel = ? AND sender_hash = ? AND status IN (${OPEN_STATES.map(() => "?").join(",")})`).get(channel, senderHash, ...OPEN_STATES);
    return row ? this.get(row.id) : null;
  }

  create({ channel, senderHash, kid, sessionRef = null }) {
    this.expireStale();
    const id = this.db.prepare(`INSERT INTO kb_ingest_submissions (channel, sender_hash, sender_hash_kid, session_ref, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`).run(channel, senderHash, kid, sessionRef === null ? null : String(sessionRef), this._iso(), this._iso()).lastInsertRowid;
    this.db.prepare(`INSERT INTO kb_ingest_submission_events (submission_id, from_status, to_status, actor, reason, created_at) VALUES (?, NULL, 'RECEIVED', 'customer', 'created', ?)`).run(id, this._iso());
    return this.get(id);
  }

  /** One transition (the DB refuses any the state machine does not allow) + its event. */
  transition(id, to, { actor = "system", messageId = null, reason = null, patch = {} } = {}) {
    return this.db.transaction(() => {
      const s = this.db.prepare(`SELECT * FROM kb_ingest_submissions WHERE id = ?`).get(id);
      if (!s) throw new Error(`unknown submission ${id}`);
      const sets = ["updated_at = ?"];
      const vals = [this._iso()];
      if (to !== s.status) {
        sets.push("status = ?");
        vals.push(to);
      }
      if (WAITING_STATES.includes(to)) {
        sets.push("expires_at = ?");
        vals.push(this._iso(this.pendingTtlMs));
      }
      if (to === "CANDIDATE") {
        sets.push("confirmed_at = ?");
        vals.push(this._iso());
      }
      if (["CLOSED", "CANCELLED", "EXPIRED", "FAILED", "NO_CONTENT"].includes(to)) {
        sets.push("closed_at = ?");
        vals.push(this._iso());
      }
      for (const [k, v] of Object.entries(patch)) {
        if (!["place_text", "place_resolution", "place_message_id", "questions_asked"].includes(k)) throw new Error(`cannot set ${k}`);
        sets.push(`${k} = ?`);
        vals.push(k === "place_resolution" && v !== null ? JSON.stringify(v) : v);
      }
      this.db.prepare(`UPDATE kb_ingest_submissions SET ${sets.join(", ")} WHERE id = ?`).run(...vals, id);
      if (to !== s.status) {
        this.db.prepare(`INSERT INTO kb_ingest_submission_events (submission_id, from_status, to_status, message_id, actor, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, s.status, to, messageId, actor, reason, this._iso());
      }
      return this.get(id);
    })();
  }

  events(id) {
    return this.db.prepare(`SELECT from_status, to_status, message_id, actor, reason, created_at FROM kb_ingest_submission_events WHERE submission_id = ? ORDER BY id`).all(id);
  }

  /** Stores one customer message of this submission as evidence (idempotent) and queues its work. */
  addMessage(submission, envelope) {
    return this.ingestion.receive({ ...envelope, sourceType: "user_contribution", submissionId: submission.id, senderHash: submission.sender_hash, senderHashKid: submission.sender_hash_kid, channel: submission.channel });
  }

  messages(id) {
    return this.db.prepare(`SELECT * FROM kb_ingest_messages WHERE submission_id = ? ORDER BY id`).all(id);
  }

  /** Job progress of the submission's messages. */
  progress(id) {
    const jobs = this.db.prepare(`SELECT j.stage, j.status, j.last_error FROM kb_ingest_jobs j JOIN kb_ingest_messages m ON m.id = j.message_id WHERE m.submission_id = ?`).all(id);
    const busy = jobs.filter((j) => ["RECEIVED", "PROCESSING"].includes(j.status));
    return {
      jobs: jobs.length,
      pending: busy.length,
      waitingProvider: jobs.filter((j) => j.status === "WAITING_PROVIDER").length,
      failed: jobs.filter((j) => j.status === "FAILED").map((j) => ({ stage: j.stage, error: j.last_error })),
      done: busy.length === 0,
    };
  }

  /** What was read from the submission so far (for the customer's reply): never raw text, only structured findings. */
  reading(id) {
    const rows = this.db
      .prepare(
        `SELECT e.id, e.message_id, e.kind, e.provider, e.model, e.output_json, e.confidence, e.created_at, e.media_id
         FROM kb_ingest_extractions e JOIN kb_ingest_messages m ON m.id = e.message_id
         WHERE m.submission_id = ? AND e.provider != 'reuse' ORDER BY e.id`
      )
      .all(id)
      .map((r) => ({ ...r, output: JSON.parse(r.output_json) }));
    const claims = rows.filter((r) => r.kind === "text_rule" || r.kind === "fusion");
    const findings = claims.flatMap((r) =>
      (r.output.findings ?? []).filter((f) => !(f.kind === "price" && PHONE_LIKE.test(String(f.rawValue ?? "").trim()))).map((f) => ({ ...f, extractionId: r.id, messageId: r.message_id, sourceId: r.output.sourceId ?? null, messageMediaId: r.output.messageMediaId ?? null, assertion: r.output.assertion ?? (r.kind === "fusion" ? "OBSERVED" : "USER_ASSERTION"), ocrConfidence: r.output.ocrConfidence ?? null }))
    );
    const media = this.db
      .prepare(`SELECT mm.id AS message_media_id, mm.message_id, f.media_id FROM kb_ingest_message_media mm JOIN kb_ingest_messages m ON m.id = mm.message_id LEFT JOIN kb_ingest_fetched f ON f.message_media_id = mm.id WHERE m.submission_id = ?`)
      .all(id);
    const visionOf = (mediaId) => {
      const own = rows.filter((r) => r.kind === "vision" && r.media_id === mediaId).at(-1);
      if (own) return own;
      // a duplicate image reuses the earlier reading of the same file
      const any = this.db.prepare(`SELECT * FROM kb_ingest_extractions WHERE kind = 'vision' AND media_id = ? AND provider != 'reuse' ORDER BY id DESC LIMIT 1`).get(mediaId);
      return any ? { ...any, output: JSON.parse(any.output_json) } : null;
    };
    const visions = media.filter((m) => m.media_id).map((m) => ({ ...m, vision: visionOf(m.media_id) })).filter((m) => m.vision);
    const documentTypes = [...new Set(visions.map((v) => v.vision.output.documentType).filter(Boolean))];
    const foods = visions.flatMap((v) => (v.vision.output.inferences ?? []).filter((i) => i.type === "food" && i.value).map((i) => ({ ...i, extractionId: v.vision.id, messageId: v.message_id, messageMediaId: v.message_media_id })));
    const places = claims.map((r) => ({ place: r.output.place, resolution: r.output.resolution, assertion: r.output.assertion })).filter((p) => p.place);
    return {
      findings,
      documentTypes,
      foods,
      places,
      rejected: claims.flatMap((r) => r.output.inputs?.rejected ?? []),
      approximateIgnored: claims.flatMap((r) => r.output.approximateIgnored ?? []),
      extractions: rows.map((r) => ({ id: r.id, kind: r.kind, provider: r.provider, model: r.model, confidence: r.confidence, created_at: r.created_at })),
    };
  }

  /** kb place resolution (the knowledge side; the service adds the FOOD catalog side). */
  resolvePlace(placeText) {
    return this.ingestion.resolver.resolve(placeText);
  }

  // ------------------------------------------------------------------ confirmation -> candidates

  /**
   * The customer confirmed: the submission's findings become candidates (review). Idempotent (unique key).
   * @param {number} id
   * @param {{catalogPrice?: (catalogMerchantId: string, productText: string, variant: string|null) => number|null,
   *          resolveFood?: (name: string) => {foodEntityId: number}|null}} [ports]
   */
  materialize(id, { catalogPrice = null, resolveFood = null } = {}) {
    const s = this.get(id);
    if (s.status !== "CANDIDATE") throw new Error(`submission ${id} is ${s.status}, not CANDIDATE`);
    const reading = this.reading(id);
    const messages = new Map(this.messages(id).map((m) => [m.id, m]));
    const place = s.place_resolution ?? null;
    // image vs text (or image vs image) that disagree on one product / field: kept both, marked CONFLICT
    const key = (f) => `${f.kind}|${normalizeName(f.productText ?? "")}|${normalizeName(f.variant ?? "")}`;
    const values = new Map();
    for (const f of reading.findings) values.set(key(f), new Set([...(values.get(key(f)) ?? []), f.normalizedValue]));
    let n = 0;
    this.db.transaction(() => {
      for (const f of reading.findings) {
        const message = messages.get(f.messageId);
        const extractionPlace = reading.places.find((p) => p) ?? null;
        const placeText = s.place_text ?? extractionPlace?.place ?? null;
        const resolution = place ?? extractionPlace?.resolution ?? { status: "none", kbPlaceId: null, candidates: [] };
        const product = f.productText ? this.ingestion.resolver.product(resolution.kbPlaceId, f.productText) : null;
        let { change, severity, previous } = detectChange(this.db, { finding: f, resolution, product });
        // the FOOD catalog (authoritative) wins: a different price there is a CONFLICT, never an update
        const catalogId = resolution.catalogMerchantId ?? null;
        if (catalogId && catalogPrice && f.kind === "price" && f.productText) {
          const official = catalogPrice(catalogId, f.productText, f.variant ?? null);
          if (typeof official === "number") {
            previous = String(official);
            if (String(official) === f.normalizedValue) ({ change, severity } = { change: "UNCHANGED", severity: "LOW" });
            else ({ change, severity } = { change: "CONFLICT", severity: "HIGH" });
          }
        }
        if ((values.get(key(f))?.size ?? 0) > 1) ({ change, severity } = { change: "CONFLICT", severity: "HIGH" });
        const food = f.productText && resolveFood ? resolveFood(f.productText) : null;
        n += this.ingestion._insertCandidate({
          message,
          extractionId: f.extractionId,
          kind: f.kind,
          placeText,
          resolution,
          productText: f.productText ?? null,
          product,
          field: fieldOf(f),
          rawValue: f.rawValue,
          normalizedValue: f.normalizedValue,
          previous,
          change,
          severity: f.assertion === "OBSERVED" && (f.ocrConfidence ?? 1) < 0.6 && severity === "LOW" ? "MEDIUM" : severity,
          confidence: confidenceOf({ role: message.sender_role, resolution, change, finding: f, fromOcr: f.assertion === "OBSERVED", ocrConfidence: f.ocrConfidence ?? (f.itemConfidence ?? null) }),
          quote: f.segment,
          sourceId: f.sourceId,
          assertion: f.assertion,
          messageMediaId: f.messageMediaId,
          placeMessageId: s.place_message_id ?? null,
          variant: f.variant ?? null,
          foodEntityId: food?.foodEntityId ?? null,
          catalogMerchantId: catalogId,
        });
      }
      // a dish recognised in a photo: FOOD (dish) only, INFERRED — never a place, price or address from a picture
      for (const g of reading.foods) {
        const message = messages.get(g.messageId);
        const food = resolveFood ? resolveFood(g.value) : null;
        n += this.ingestion._insertCandidate({
          message,
          extractionId: g.extractionId,
          kind: "food",
          placeText: null,
          resolution: { status: "none", kbPlaceId: null, candidates: [] },
          productText: g.value,
          product: null,
          field: "dish",
          rawValue: g.value,
          normalizedValue: normalizeName(g.value),
          change: "UNCERTAIN",
          severity: "LOW",
          confidence: Math.round(Math.min(0.9, (g.confidence ?? 0.5) * 0.7) * 100) / 100,
          quote: `[vision] ${g.value}`,
          sourceId: null,
          assertion: "INFERRED",
          messageMediaId: g.messageMediaId,
          foodEntityId: food?.foodEntityId ?? null,
        });
      }
    })();
    return n;
  }

  candidates(id) {
    return this.db
      .prepare(`SELECT c.* FROM kb_ingest_candidates c JOIN kb_ingest_messages m ON m.id = c.message_id WHERE m.submission_id = ? ORDER BY c.id`)
      .all(id)
      .map((c) => ({ ...c, place_resolution: JSON.parse(c.place_resolution) }));
  }

  /** CANDIDATE -> CLOSED once every candidate of it has been decided. */
  closeIfDecided(id) {
    const s = this.get(id);
    if (s?.status !== "CANDIDATE") return false;
    const open = this.db.prepare(`SELECT COUNT(*) AS n FROM kb_ingest_candidates c JOIN kb_ingest_messages m ON m.id = c.message_id WHERE m.submission_id = ? AND c.status = 'review'`).get(id).n;
    if (open) return false;
    this.transition(id, "CLOSED", { actor: "system", reason: "all_candidates_decided" });
    return true;
  }

  // ------------------------------------------------------------------ retrieval (USER_CONTRIBUTED_UNVERIFIED_EVIDENCE)

  /**
   * Visible, non-expired candidates. Never raw text, OCR text, quotes, media refs or who sent them.
   * @param {{kbMerchantIds?: number[], catalogMerchantIds?: string[], foodEntityIds?: number[], names?: string[], field?: string, senderHash?: string|null, ownOnly?: boolean, limit?: number}} q
   */
  visible({ kbMerchantIds = [], catalogMerchantIds = [], foodEntityIds = [], names = [], field = null, senderHash = null, ownOnly = false, limit = MAX_VISIBLE } = {}) {
    const rows = this.db.prepare(`SELECT * FROM kb_contribution_visible ORDER BY captured_at DESC, candidate_id DESC LIMIT 500`).all();
    const nowMs = this.now().getTime();
    const wantNames = names.map((n) => normalizeName(n)).filter(Boolean);
    const out = rows.filter((r) => {
      if (field && r.field !== field) return false;
      // an implausible amount (1đ, an OCR slip, an instruction written as text) is for the reviewer only
      if (r.field === "price" && !PLAUSIBLE_PRICE(r.value)) return false;
      const ttl = FIELD_TTL_DAYS[r.field] ?? 180;
      if ((nowMs - Date.parse(String(r.captured_at).replace(" ", "T") + (String(r.captured_at).endsWith("Z") ? "" : "Z"))) / 86_400_000 > ttl) return false;
      if (ownOnly && (!senderHash || r.sender_hash !== senderHash)) return false;
      const byPlace = (r.kb_merchant_id && kbMerchantIds.includes(r.kb_merchant_id)) || (r.catalog_merchant_id && catalogMerchantIds.includes(r.catalog_merchant_id));
      const byFood = (r.food_entity_id && foodEntityIds.includes(r.food_entity_id)) || (wantNames.length && r.name_as_written && wantNames.some((w) => ` ${normalizeName(r.name_as_written)} `.includes(` ${w} `)));
      const scoped = kbMerchantIds.length || catalogMerchantIds.length;
      if (scoped && !byPlace) return false;
      if ((foodEntityIds.length || wantNames.length) && !byFood) return false;
      return true;
    });
    return out.slice(0, limit).map((r) => ({ ...r, own_contribution: Boolean(senderHash && r.sender_hash === senderHash), sender_hash: undefined }));
  }

  // ------------------------------------------------------------------ erasure / retention

  /**
   * "Xoá đóng góp của tôi": the person's words and images are deleted from disk (hash rows stay), their open
   * candidates are rejected, open submissions cancelled. Applied (published) facts keep their evidence row.
   */
  erase(channel, senderHash, { by = "system:contributor_request" } = {}) {
    const msgs = this.db.prepare(`SELECT * FROM kb_ingest_messages WHERE channel = ? AND sender_hash = ?`).all(channel, senderHash);
    let files = 0;
    this.db.transaction(() => {
      for (const s of this.db.prepare(`SELECT id, status FROM kb_ingest_submissions WHERE channel = ? AND sender_hash = ? AND status IN (${OPEN_STATES.map(() => "?").join(",")})`).all(channel, senderHash, ...OPEN_STATES)) {
        this.transition(s.id, "CANCELLED", { actor: "customer", reason: "contributor_request" });
      }
      for (const m of msgs) {
        this.db.prepare(`UPDATE kb_ingest_candidates SET status = 'rejected', decided_by = 'system:contributor_request', decided_at = datetime('now'), decision_note = 'contributor_request' WHERE message_id = ? AND status = 'review'`).run(m.id);
        if (m.source_id && this._purge("source", m.source_id, by)) files += 1;
        for (const f of this.db.prepare(`SELECT f.media_id FROM kb_ingest_message_media mm JOIN kb_ingest_fetched f ON f.message_media_id = mm.id WHERE mm.message_id = ?`).all(m.id)) {
          // a file another person also sent, or that backs a published fact, is kept
          const shared = this.db.prepare(`SELECT COUNT(*) AS n FROM kb_ingest_fetched f JOIN kb_ingest_message_media mm ON mm.id = f.message_media_id JOIN kb_ingest_messages x ON x.id = mm.message_id WHERE f.media_id = ? AND (x.sender_hash IS NOT ? OR x.channel != ?)`).get(f.media_id, senderHash, channel).n;
          const applied = this.db.prepare(`SELECT COUNT(*) AS n FROM kb_ingest_candidates c WHERE c.status = 'applied' AND c.message_media_id IN (SELECT id FROM kb_ingest_message_media WHERE message_id IN (SELECT id FROM kb_ingest_messages WHERE sender_hash = ?))`).get(senderHash).n;
          if (!shared && !applied && this._purge("media", f.media_id, by)) files += 1;
        }
      }
    })();
    return { messages: msgs.length, filesPurged: files };
  }

  _purge(kind, id, by) {
    if (this.db.prepare(`SELECT 1 FROM kb_ingest_purges WHERE target_kind = ? AND target_id = ?`).get(kind, id)) return false;
    const rel = kind === "media" ? this.db.prepare(`SELECT storage_ref AS p FROM kb_ingest_media WHERE id = ?`).get(id)?.p : this.db.prepare(`SELECT raw_path AS p FROM kb_sources WHERE id = ?`).get(id)?.p;
    if (rel) fs.rmSync(path.resolve(this.ingestion.rawRoot, rel), { force: true });
    this.db.prepare(`INSERT INTO kb_ingest_purges (target_kind, target_id, reason, purged_by) VALUES (?, ?, 'contributor_request', ?)`).run(kind, id, by);
    return true;
  }

  hasFood(id) {
    return Boolean(id && this.db.prepare(`SELECT 1 FROM kb_food_entities WHERE id = ?`).get(id));
  }

  mediaCount(id) {
    return this.db.prepare(`SELECT COUNT(*) AS n FROM kb_ingest_message_media mm JOIN kb_ingest_messages m ON m.id = mm.message_id WHERE m.submission_id = ?`).get(id).n;
  }

  /** Images this person sent since `sinceIso` (rate caps). */
  imagesSince(channel, senderHash, sinceIso) {
    return this.db
      .prepare(`SELECT COUNT(*) AS n FROM kb_ingest_message_media mm JOIN kb_ingest_messages m ON m.id = mm.message_id WHERE m.channel = ? AND m.sender_hash = ? AND m.received_at >= ?`)
      .get(channel, senderHash, sinceIso).n;
  }
}
