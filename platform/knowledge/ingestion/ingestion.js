import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { PlaceResolver } from "./resolve.js";
import { extractClaims, explicitPlace } from "./textClaims.js";
import { detectChange, confidenceOf } from "./changes.js";
import { normalizeName } from "../text.js";
import { checkImage, IMAGE_LIMITS } from "./imageCheck.js";
import { imageFindings, isApproximate } from "./imageFindings.js";

// Knowledge Ingestion: Knowledge Group message -> immutable evidence -> readers
// (rules, OCR, vision) -> resolution -> change detection -> CANDIDATES for review.
//
// receive() is synchronous and small (store + queue): a webhook can acknowledge
// at once. processPending() does the slow work, with retries; every stage keeps
// what it produced, so an OCR / vision / model outage never loses evidence.
// V1 publishes NOTHING: every candidate waits for a person (AUTO_PUBLISH = false).

const MAX_ATTEMPTS = 5;
const MAX_MEDIA_BYTES = 20 * 1024 * 1024;
const LOW_OCR_CONFIDENCE = 0.6;
const fieldOf = (finding) => (finding.kind === "price" ? "price" : finding.kind === "availability" ? "availability" : finding.kind);
const EXT = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "application/pdf": "pdf" };
const safe = (s) => String(s).replace(/[^A-Za-z0-9_-]/g, "_");
const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const permanent = (message) => Object.assign(new Error(message), { permanent: true });
// opening-hours cue: in the hour range's own segment or the line just above it (a menu header "Giờ mở cửa:")
const HOURS_CUE = /(?:mở cửa|mo cua|giờ mở|gio mo|giờ hoạt động|gio hoat dong|hoạt động từ|hoat dong tu|phục vụ|phuc vu|mở từ|mo tu|mở bán|mo ban|giờ bán|gio ban|giờ làm việc|opening hours|open)/iu;
function hasHoursCue(text, segment) {
  if (HOURS_CUE.test(segment)) return true;
  const lines = String(text ?? "").split(/\r?\n/).map((l) => l.trim());
  const first = String(segment).split(/\r?\n/)[0].trim();
  const at = lines.findIndex((l) => l.includes(first));
  return at > 0 && HOURS_CUE.test(lines[at - 1]);
}

const BARE_ADDRESS = /^\s*địa\s+chỉ\s+(?!mới(?:\s|$|[:：]))([^:：\s].*)$/iu;
function withBareAddresses(text, findings) {
  let out = findings;
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const m = line.match(BARE_ADDRESS);
    if (!m) continue;
    const segment = line.trim();
    if (out.some((f) => f.kind === "address" && f.segment === segment)) continue;
    const value = m[1].trim().replace(/[.;,]+$/u, "");
    out = [...out.filter((f) => f.segment !== segment), { segment, kind: "address", rawValue: value, normalizedValue: value }];
  }
  return out;
}

export class KnowledgeIngestion {
  /**
   * @param {object} deps
   * @param {import("better-sqlite3").Database} deps.db the WORKING knowledge DB (migrated)
   * @param {import("../store.js").KnowledgeStore} deps.knowledge registers raw sources (hash + immutable file)
   * @param {string} deps.rawRoot where raw text / media / OCR text files are kept
   * @param {{read: Function}|null} [deps.ocr]  @param {{describe: Function}|null} [deps.vision]
   * @param {((fileId: string) => Promise<{buffer: Buffer, mimeType?: string, filename?: string}>)|null} [deps.fetchMedia]
   */
  constructor({ db, knowledge, rawRoot, ocr = null, vision = null, fetchMedia = null, logger = null, now = () => new Date(), imageLimits = IMAGE_LIMITS }) {
    this.db = db;
    this.imageLimits = imageLimits;
    this.knowledge = knowledge;
    this.rawRoot = rawRoot;
    this.ocr = ocr;
    this.vision = vision;
    this.fetchMedia = fetchMedia;
    this.logger = logger;
    this.now = now;
    this.resolver = new PlaceResolver(db);
  }

  // ------------------------------------------------------------------ contributors

  roleOf(channel, userId) {
    if (!userId) return "member";
    return this.db.prepare(`SELECT role FROM kb_ingest_contributors WHERE channel = ? AND external_user_id = ?`).get(channel, String(userId))?.role ?? "member";
  }

  setContributor({ channel, userId, role, addedBy }) {
    if (!addedBy) throw new Error("addedBy is required");
    this.db
      .prepare(`INSERT INTO kb_ingest_contributors (channel, external_user_id, role, added_by) VALUES (?, ?, ?, ?) ON CONFLICT(channel, external_user_id) DO UPDATE SET role = excluded.role, added_by = excluded.added_by`)
      .run(channel, String(userId), role, addedBy);
  }

  // ------------------------------------------------------------------ receive (fast, idempotent)

  /**
   * @param {{channel, chatId, messageId, updateId?, senderId?, senderName?, sentAt?, text?, caption?, replyTo?, mediaGroupId?, media?: {type, fileId, mimeType?, filename?}[], raw: object}} m
   * @returns {{status: "received"|"duplicate", id: number, jobs: number}}
   */
  receive(m) {
    const existing = this.db.prepare(`SELECT id FROM kb_ingest_messages WHERE channel = ? AND chat_id = ? AND message_id = ?`).get(m.channel, String(m.chatId), String(m.messageId));
    if (existing) return { status: "duplicate", id: existing.id, jobs: 0 };
    // a customer (user_contribution) is known only by a keyed hash, and their words only by the raw source file
    const customer = m.sourceType === "user_contribution";
    if (customer && (!m.senderHash || !String(m.chatId).startsWith("h1:") || !m.submissionId)) throw new Error("a customer contribution needs sender_hash, a hashed chat id and a submission");
    const role = this.roleOf(m.channel, customer ? m.senderHash : m.senderId);
    const receivedAt = this.now().toISOString();
    const words = [m.text, m.caption].filter((x) => typeof x === "string" && x.trim());
    let sourceId = null;
    if (words.length) {
      const rel = path.join("ingest", safe(m.channel), safe(m.chatId), `${safe(m.messageId)}.txt`);
      this._writeOnce(rel, words.join("\n"));
      sourceId = this.knowledge.registerSource({
        url: `${m.channel}://chat/${m.chatId}/message/${m.messageId}`,
        sourceType: customer ? "user_contribution" : "knowledge_group",
        rawPath: rel,
        contentType: "text/plain",
        fetchedAt: receivedAt,
        publishedAt: m.sentAt ?? null,
      }).id;
    }
    let jobs = 0;
    const id = this.db.transaction(() => {
      const messageRow = customer
        ? this.db
            .prepare(
              `INSERT INTO kb_ingest_messages (channel, chat_id, message_id, update_id, sender_id, sender_display_name, sender_role, sent_at, text, caption, reply_to_message_id, media_group_id, raw_update_json, source_id, received_at, source_type, submission_id, sender_hash, sender_hash_kid)
               VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, 'user_contribution', ?, ?, ?)`
            )
            .run(m.channel, String(m.chatId), String(m.messageId), m.updateId ?? null, role, m.sentAt ?? null, m.replyTo ?? null, m.mediaGroupId ?? null, JSON.stringify(m.raw ?? {}), sourceId, receivedAt, m.submissionId, m.senderHash, m.senderHashKid ?? "k1").lastInsertRowid
        : this.db
            .prepare(
              `INSERT INTO kb_ingest_messages (channel, chat_id, message_id, update_id, sender_id, sender_display_name, sender_role, sent_at, text, caption, reply_to_message_id, media_group_id, raw_update_json, source_id, received_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            )
            .run(m.channel, String(m.chatId), String(m.messageId), m.updateId ?? null, m.senderId ? String(m.senderId) : null, m.senderName ?? null, role, m.sentAt ?? null, m.text ?? null, m.caption ?? null, m.replyTo ?? null, m.mediaGroupId ?? null, JSON.stringify(m.raw ?? {}), sourceId, receivedAt).lastInsertRowid;
      const addJob = (stage, item = 0) => {
        this.db.prepare(`INSERT OR IGNORE INTO kb_ingest_jobs (message_id, stage, item, status) VALUES (?, ?, ?, 'RECEIVED')`).run(messageRow, stage, item);
        jobs += 1;
      };
      (m.media ?? []).forEach((media, position) => {
        const mm = this.db
          .prepare(`INSERT INTO kb_ingest_message_media (message_id, position, media_type, external_file_id, mime_type, original_filename) VALUES (?, ?, ?, ?, ?, ?)`)
          .run(messageRow, position, media.type, media.fileId, media.mimeType ?? null, media.filename ?? null).lastInsertRowid;
        if (role !== "blocked") addJob("media_fetch", mm);
      });
      // a blocked sender's message is kept as evidence, and nothing is derived from it
      if (sourceId && role !== "blocked") addJob("text");
      return messageRow;
    })();
    this._log("received", { ingestionId: id, role, jobs, status: "RECEIVED", sourceType: customer ? "user_contribution" : "knowledge_group" });
    return { status: "received", id, jobs };
  }

  /** What the message said (text + caption): from the row for the group, from the raw source file for a customer. */
  _words(message) {
    if (message.source_type !== "user_contribution") return [message.text, message.caption].filter(Boolean).join("\n");
    return message.source_id && !this._purged("source", message.source_id) ? this._sourceText(message.source_id) : "";
  }

  _purged(kind, id) {
    return Boolean(this.db.prepare(`SELECT 1 FROM kb_ingest_purges WHERE target_kind = ? AND target_id = ?`).get(kind, id));
  }

  _writeOnce(rel, content) {
    const file = path.resolve(this.rawRoot, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (!fs.existsSync(file)) fs.writeFileSync(file, content, { flag: "wx" });
    else if (fs.readFileSync(file, "utf8") !== String(content)) throw new Error(`raw evidence ${rel} already exists with other content`);
  }

  // ------------------------------------------------------------------ processing (slow, retried)

  async processPending({ limit = 20 } = {}) {
    const nowIso = this.now().toISOString();
    const due = this.db
      .prepare(
        `SELECT * FROM kb_ingest_jobs
         WHERE (status = 'RECEIVED' OR (status = 'WAITING_PROVIDER' AND ((stage = 'ocr' AND ?) OR (stage = 'vision' AND ?) OR (stage = 'media_fetch' AND ?) OR (stage = 'fusion' AND ?))))
           AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
         ORDER BY id LIMIT ?`
      )
      .all(this.ocr ? 1 : 0, this.vision ? 1 : 0, this.fetchMedia ? 1 : 0, this.ocr ? 1 : 0, nowIso, limit);
    const results = [];
    for (const job of due) results.push(await this._run(job));
    return results;
  }

  /** Runs rounds until nothing is due (a stage queues the next one: fetch -> OCR / vision -> fusion). */
  async drain({ maxRounds = 10, limit = 20 } = {}) {
    const all = [];
    for (let round = 0; round < maxRounds; round++) {
      const results = await this.processPending({ limit });
      if (!results.length) break;
      all.push(...results);
    }
    return all;
  }

  async _run(job) {
    const started = Date.now();
    this.db.prepare(`UPDATE kb_ingest_jobs SET status = 'PROCESSING', attempts = attempts + 1, updated_at = datetime('now') WHERE id = ?`).run(job.id);
    try {
      const status = await this[`_${job.stage}`](job);
      this.db.prepare(`UPDATE kb_ingest_jobs SET status = ?, last_error = NULL, next_attempt_at = NULL, updated_at = datetime('now') WHERE id = ?`).run(status, job.id);
      this._log(job.stage, { ingestionId: job.message_id, jobId: job.id, item: job.item, status, latencyMs: Date.now() - started });
      return { jobId: job.id, stage: job.stage, status };
    } catch (err) {
      const attempts = job.attempts + 1;
      // a file that can never be valid (wrong type, corrupt, too large) fails at once: retrying cannot help
      const failed = attempts >= MAX_ATTEMPTS || err?.permanent === true;
      const next = new Date(this.now().getTime() + 2 ** attempts * 60_000).toISOString();
      const message = String(err?.message ?? err).slice(0, 300);
      this.db.prepare(`UPDATE kb_ingest_jobs SET status = ?, last_error = ?, next_attempt_at = ?, updated_at = datetime('now') WHERE id = ?`).run(failed ? "FAILED" : "RECEIVED", message, failed ? null : next, job.id);
      this._log(job.stage, { ingestionId: job.message_id, jobId: job.id, item: job.item, status: failed ? "FAILED" : "RETRY", attempts, error: message, latencyMs: Date.now() - started });
      return { jobId: job.id, stage: job.stage, status: failed ? "FAILED" : "RETRY", error: message };
    }
  }

  _message(id) {
    return this.db.prepare(`SELECT * FROM kb_ingest_messages WHERE id = ?`).get(id);
  }

  _sourceText(sourceId) {
    const source = this.db.prepare(`SELECT raw_path FROM kb_sources WHERE id = ?`).get(sourceId);
    return fs.readFileSync(path.resolve(this.rawRoot, source.raw_path), "utf8");
  }

  // text / caption: rules read what is written
  async _text(job) {
    const message = this._message(job.message_id);
    const text = this._sourceText(message.source_id);
    const n = this._claimsFrom({ message, text, sourceId: message.source_id, contextText: text, extraction: { kind: "text_rule", provider: "rules", model: "textClaims@1" } });
    return n ? "REVIEW" : "DONE";
  }

  // the medium itself: fetched once, stored content-addressed; the same file twice is one media row
  async _media_fetch(job) {
    if (!this.fetchMedia) return "WAITING_PROVIDER";
    const mm = this.db.prepare(`SELECT * FROM kb_ingest_message_media WHERE id = ?`).get(job.item);
    const message = this._message(job.message_id);
    const got = await this.fetchMedia(mm.external_file_id, { channel: message.channel, mediaType: mm.media_type });
    if (!got?.buffer?.length) throw permanent("empty media");
    if (got.buffer.length > MAX_MEDIA_BYTES) throw permanent(`media too large (${got.buffer.length} bytes)`);
    let mimeType = got.mimeType ?? mm.mime_type ?? null;
    // a customer's file must be a real, complete image (type from the bytes, never the claimed MIME / name)
    if (message.source_type === "user_contribution") {
      const check = checkImage(got.buffer, { claimedMimeType: mimeType, limits: this.imageLimits });
      if (!check.ok) throw permanent(`image rejected: ${check.reason}${check.detail ? ` (${check.detail})` : ""}`);
      mimeType = check.mimeType;
    }
    const hash = sha256(got.buffer);
    let media = this.db.prepare(`SELECT * FROM kb_ingest_media WHERE sha256 = ?`).get(hash);
    const duplicate = Boolean(media);
    if (!media) {
      const rel = path.join("ingest", "media", hash.slice(0, 2), `${hash}.${EXT[mimeType] ?? "bin"}`);
      const file = path.resolve(this.rawRoot, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      if (!fs.existsSync(file)) fs.writeFileSync(file, got.buffer, { flag: "wx" });
      this.db.prepare(`INSERT INTO kb_ingest_media (sha256, mime_type, size_bytes, storage_ref, original_filename) VALUES (?, ?, ?, ?, ?)`).run(hash, mimeType, got.buffer.length, rel, got.filename ?? mm.original_filename ?? null);
      media = this.db.prepare(`SELECT * FROM kb_ingest_media WHERE sha256 = ?`).get(hash);
    }
    this.db.prepare(`INSERT OR IGNORE INTO kb_ingest_fetched (message_media_id, media_id, duplicate_of_earlier) VALUES (?, ?, ?)`).run(mm.id, media.id, duplicate ? 1 : 0);
    for (const stage of ["ocr", "vision", "fusion"]) this.db.prepare(`INSERT OR IGNORE INTO kb_ingest_jobs (message_id, stage, item, status) VALUES (?, ?, ?, 'RECEIVED')`).run(job.message_id, stage, mm.id);
    return "DONE";
  }

  _fetched(item) {
    return this.db.prepare(`SELECT m.* FROM kb_ingest_fetched f JOIN kb_ingest_media m ON m.id = f.media_id WHERE f.message_media_id = ?`).get(item);
  }

  _latest(kind, mediaId) {
    return this.db.prepare(`SELECT * FROM kb_ingest_extractions WHERE kind = ? AND media_id = ? AND provider != 'reuse' ORDER BY id DESC LIMIT 1`).get(kind, mediaId);
  }

  // OCR once per file: a file seen before reuses its reading
  async _ocr(job) {
    const media = this._fetched(job.item);
    const earlier = this._latest("ocr", media.id);
    if (earlier) {
      this._extraction({ messageId: job.message_id, mediaId: media.id, kind: "ocr", provider: "reuse", model: null, output: { reusedExtractionId: earlier.id }, confidence: earlier.confidence });
      return "DONE";
    }
    if (!this.ocr) return "WAITING_PROVIDER";
    const r = await this.ocr.read({ path: path.resolve(this.rawRoot, media.storage_ref), mimeType: media.mime_type, sha256: media.sha256 });
    const output = { text: String(r.text ?? ""), blocks: r.blocks ?? [], language: r.language ?? null };
    const extractionId = this._extraction({ messageId: job.message_id, mediaId: media.id, kind: "ocr", provider: r.provider ?? "ocr", model: r.model ?? null, output, confidence: r.confidence ?? null });
    // the OCR text becomes a raw source of its own, so every quote from it is checked like any other
    if (output.text.trim()) {
      const rel = path.join("ingest", "ocr", `${media.sha256}-${extractionId}.txt`);
      this._writeOnce(rel, output.text);
      const sourceType = this._message(job.message_id).source_type === "user_contribution" ? "user_contribution" : "knowledge_group";
      this.knowledge.registerSource({ url: `ocr://${media.sha256}/${extractionId}`, sourceType, rawPath: rel, contentType: "text/plain", fetchedAt: this.now().toISOString() });
    }
    return "EXTRACTED";
  }

  // vision: observations (seen) kept apart from inferences (maybe) — an inference is never a fact
  async _vision(job) {
    const media = this._fetched(job.item);
    const earlier = this._latest("vision", media.id);
    if (earlier) {
      this._extraction({ messageId: job.message_id, mediaId: media.id, kind: "vision", provider: "reuse", model: null, output: { reusedExtractionId: earlier.id }, confidence: earlier.confidence });
      return "DONE";
    }
    if (!this.vision) return "WAITING_PROVIDER";
    const message = this._message(job.message_id);
    const r = await this.vision.describe({ path: path.resolve(this.rawRoot, media.storage_ref), mimeType: media.mime_type, sha256: media.sha256, caption: this._words(message) || null });
    const output = { observations: r.observations ?? [], inferences: (r.inferences ?? []).map((i) => ({ type: i.type, value: i.value, confidence: i.confidence ?? null })) };
    // a structured reader (image understanding) also says what kind of image it is and what it lists — still PROPOSALS
    if (r.documentType) output.documentType = r.documentType;
    if (Array.isArray(r.items)) output.items = r.items;
    if (r.merchant) output.merchant = r.merchant;
    if (r.address) output.address = r.address;
    this._extraction({ messageId: job.message_id, mediaId: media.id, kind: "vision", provider: r.provider ?? "vision", model: r.model ?? null, output, confidence: r.confidence ?? null });
    return "EXTRACTED";
  }

  _reading(kind, mediaId) {
    const row = this._latest(kind, mediaId);
    return row ? { ...row, output: JSON.parse(row.output_json) } : null;
  }

  // fusion: caption + message text + OCR + vision, read together
  async _fusion(job) {
    const media = this._fetched(job.item);
    const ocrJob = this.db.prepare(`SELECT status FROM kb_ingest_jobs WHERE message_id = ? AND stage = 'ocr' AND item = ?`).get(job.message_id, job.item);
    const ocr = this._reading("ocr", media.id);
    if (!ocr) {
      if (ocrJob?.status === "FAILED") return "DONE"; // nothing to read; the image and the caption stay as evidence
      if (ocrJob?.status === "WAITING_PROVIDER") return "WAITING_PROVIDER"; // resumes when an OCR provider exists
      throw new Error("waiting for OCR"); // retried later (backoff) — never treated as "no text"
    }
    const vision = this._reading("vision", media.id);
    const message = this._message(job.message_id);
    const context = this._words(message);
    const customer = message.source_type === "user_contribution";
    const ocrSource = this.db.prepare(`SELECT id FROM kb_sources WHERE url LIKE ? ORDER BY id DESC LIMIT 1`).get(`ocr://${media.sha256}/%`);
    let n = 0;
    if (ocr.output.text.trim() && ocrSource) {
      // a structured reading (menu items / merchant / address) counts only where the OCR text of the image shows it
      const structured = vision?.output.items || vision?.output.merchant || vision?.output.address ? imageFindings(vision.output, ocr.output.text) : null;
      const itemFindings = structured?.findings.filter((f) => f.kind === "price" || f.kind === "product") ?? [];
      n += this._claimsFrom({
        message,
        text: ocr.output.text,
        sourceId: ocrSource.id,
        contextText: `${context}\n${ocr.output.text}`,
        extraction: {
          kind: "fusion",
          provider: "rules",
          model: itemFindings.length ? "imageItems@1+ocr" : "textClaims@1+ocr",
          inputs: { ocrExtractionId: ocr.id, visionExtractionId: vision?.id ?? null, documentType: vision?.output.documentType ?? null, ...(structured?.rejected.length && { rejected: structured.rejected }) },
        },
        ocrConfidence: ocr.confidence,
        findings: itemFindings.length ? structured.findings : structured?.findings.length ? [...structured.findings, ...extractClaims(ocr.output.text)] : null,
        imagePlace: structured?.placeText ?? null,
        messageMediaId: job.item,
        assertion: "OBSERVED",
      });
    }
    // a dish recognised in a photo: a FOOD candidate only — no place, no price, no address from a picture
    // (a customer's is created at confirmation, from this vision reading — see materialize())
    const foods = customer ? [] : (vision?.output.inferences ?? []).filter((i) => i.type === "food" && i.value);
    for (const f of foods) {
      const captioned = context && normalizeName(context).includes(normalizeName(f.value));
      n += this._insertCandidate({
        message,
        extractionId: vision.id,
        kind: "food",
        placeText: null,
        resolution: { status: "none", kbPlaceId: null, candidates: [] },
        productText: f.value,
        product: null,
        field: "dish",
        rawValue: f.value,
        normalizedValue: normalizeName(f.value),
        change: "UNCERTAIN",
        severity: "LOW",
        confidence: Math.round(Math.min(0.9, (f.confidence ?? 0.5) * (captioned ? 1 : 0.7)) * 100) / 100,
        quote: captioned ? context : `[vision] ${f.value}`,
        sourceId: captioned ? message.source_id : null,
        assertion: "INFERRED",
        messageMediaId: job.item,
      });
    }
    if (customer) return "EXTRACTED";
    return n ? "REVIEW" : "DONE";
  }

  // ------------------------------------------------------------------ claims -> candidates

  _claimsFrom({ message, text, sourceId, contextText, extraction, ocrConfidence = null, findings: given = null, imagePlace = null, messageMediaId = null, assertion = null }) {
    const found = this.resolver.findInText(contextText);
    const placeText = found?.written ?? imagePlace ?? explicitPlace(contextText) ?? null;
    const resolution = found ? this.resolver.resolve(found.normalized) : this.resolver.resolve(placeText);
    const customer = message.source_type === "user_contribution";
    let findings = given ?? extractClaims(text, { placeTexts: found ? [found.written] : [] });
    // a customer's approximate amount ("khoảng 45k") is never read as a price
    const approximate = customer ? findings.filter((f) => f.kind === "price" && isApproximate(f.segment, f.rawValue)) : [];
    if (approximate.length) findings = findings.filter((f) => !approximate.includes(f));
    // a customer's hour range is opening hours only next to an opening-hours cue ("Cúp điện từ 8h đến 11h" is not)
    const notHours = customer ? findings.filter((f) => f.kind === "opening_hours" && !String(f.normalizedValue).startsWith("closed:") && !hasHoursCue(text, f.segment)) : [];
    if (notHours.length) findings = findings.filter((f) => !notHours.includes(f));
    // "Địa chỉ 123 Nguyễn Trãi" without a colon, in a contributor's own words: an address line (never a price)
    if (customer && extraction.kind === "text_rule") findings = withBareAddresses(text, findings);
    const kind = assertion ?? (extraction.kind === "fusion" ? "OBSERVED" : "USER_ASSERTION");
    const extractionId = this._extraction({
      messageId: message.id,
      mediaId: null,
      kind: extraction.kind,
      provider: extraction.provider,
      model: extraction.model,
      output: {
        place: placeText,
        resolution,
        findings,
        ...(extraction.inputs && { inputs: extraction.inputs }),
        ...(customer && { sourceId, messageMediaId, assertion: kind, ocrConfidence, ...(approximate.length && { approximateIgnored: approximate.map((f) => f.segment) }), ...(notHours.length && { hoursWithoutCueIgnored: notHours.map((f) => f.segment) }) }),
      },
      confidence: ocrConfidence,
    });
    // a customer's findings become candidates only when the customer confirms the submission (materialize)
    if (customer) return findings.length;
    let n = 0;
    for (const finding of findings) {
      const product = finding.productText ? this.resolver.product(resolution.kbPlaceId, finding.productText) : null;
      let { change, severity, previous } = detectChange(this.db, { finding, resolution, product });
      if (this._pendingDuplicate({ message, resolution, placeText, finding })) {
        change = "DUPLICATE";
        severity = "LOW";
      }
      const fromOcr = extraction.kind === "fusion";
      if (fromOcr && (ocrConfidence ?? 0) < LOW_OCR_CONFIDENCE && severity === "LOW") severity = "MEDIUM"; // an unsure reading is never a low-risk change
      n += this._insertCandidate({
        message,
        extractionId,
        kind: finding.kind,
        placeText,
        resolution,
        productText: finding.productText ?? null,
        product,
        field: fieldOf(finding),
        rawValue: finding.rawValue,
        normalizedValue: finding.normalizedValue,
        previous,
        change,
        severity,
        confidence: confidenceOf({ role: message.sender_role, resolution, change, finding, fromOcr, ocrConfidence }),
        quote: finding.segment,
        sourceId,
        assertion: kind,
        messageMediaId,
        variant: finding.variant ?? null,
      });
    }
    return n;
  }

  _pendingDuplicate({ message, resolution, placeText, finding }) {
    const rows = this.db
      .prepare(`SELECT place_resolution, place_text, product_text, normalized_value FROM kb_ingest_candidates WHERE status = 'review' AND kind = ? AND message_id != ? AND normalized_value = ?`)
      .all(finding.kind, message.id, finding.normalizedValue);
    return rows.some((r) => {
      const other = JSON.parse(r.place_resolution);
      const samePlace = resolution.kbPlaceId ? other.kbPlaceId === resolution.kbPlaceId : normalizeName(r.place_text ?? "") === normalizeName(placeText ?? "");
      return samePlace && normalizeName(r.product_text ?? "") === normalizeName(finding.productText ?? "");
    });
  }

  _insertCandidate(c) {
    return this.db
      .prepare(
        `INSERT OR IGNORE INTO kb_ingest_candidates (message_id, extraction_id, kind, place_text, place_resolution, product_text, kb_product_id, field, raw_value, normalized_value, previous_value, change, severity, confidence, evidence_quote, source_id,
                                                     assertion_kind, message_media_id, place_message_id, variant, food_entity_id, catalog_merchant_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        c.message.id, c.extractionId, c.kind, c.placeText, JSON.stringify(c.resolution), c.productText, c.product?.id ?? null, c.field, c.rawValue, c.normalizedValue, c.previous ?? null, c.change, c.severity, c.confidence, c.quote, c.sourceId,
        c.assertion ?? "USER_ASSERTION", c.messageMediaId ?? null, c.placeMessageId ?? null, c.variant ?? null, c.foodEntityId ?? null, c.catalogMerchantId ?? null
      ).changes;
  }

  _extraction({ messageId, mediaId, kind, provider, model, output, confidence }) {
    return this.db
      .prepare(`INSERT INTO kb_ingest_extractions (message_id, media_id, kind, provider, model, output_json, confidence) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(messageId, mediaId, kind, provider, model, JSON.stringify(output), confidence).lastInsertRowid;
  }

  // ------------------------------------------------------------------ review

  listCandidates({ status = "review", limit = 50 } = {}) {
    return this.db
      .prepare(
        `SELECT c.*, m.channel, m.chat_id, m.message_id AS external_message_id, m.sender_role, m.sent_at
         FROM kb_ingest_candidates c JOIN kb_ingest_messages m ON m.id = c.message_id
         WHERE c.status = ? ORDER BY CASE c.severity WHEN 'HIGH' THEN 0 WHEN 'MEDIUM' THEN 1 ELSE 2 END, c.confidence DESC, c.id LIMIT ?`
      )
      .all(status, limit)
      .map((c) => ({ ...c, place_resolution: JSON.parse(c.place_resolution) }));
  }

  /** A person's decision. Nobody approves their own contribution; an approval does not publish (V1). */
  decide(id, { approve, by, note = null }) {
    if (!by) throw new Error("a decision needs the deciding person");
    const c = this.db.prepare(`SELECT c.*, m.channel, m.sender_id FROM kb_ingest_candidates c JOIN kb_ingest_messages m ON m.id = c.message_id WHERE c.id = ?`).get(id);
    if (!c) throw new Error(`unknown candidate ${id}`);
    if (c.status !== "review") throw new Error(`candidate ${id} is already ${c.status}`);
    if (c.sender_id && by === `${c.channel}:${c.sender_id}`) throw new Error("a contributor cannot decide on their own contribution");
    this.db.prepare(`UPDATE kb_ingest_candidates SET status = ?, decided_by = ?, decided_at = datetime('now'), decision_note = ? WHERE id = ?`).run(approve ? "approved" : "rejected", by, note, id);
    return this.db.prepare(`SELECT * FROM kb_ingest_candidates WHERE id = ?`).get(id);
  }

  _log(stage, meta) {
    this.logger?.info?.("KNOWLEDGE_INGEST", stage, meta);
  }
}
