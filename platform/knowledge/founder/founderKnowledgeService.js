import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { collapseWhitespace, nfc } from "../text.js";
import { FounderKnowledgeRepository } from "./founderRepository.js";

// Founder / Business Knowledge (FK-1): the founder's policies, advice style, FAQ, FOOD recommendations and
// internal notes — TEXT only in FK-1, with provenance, versions and a human approval.
//
// Rules this service keeps (the DB triggers of migration 006 keep them too):
//   * it is guidance, never an authoritative fact: it never writes the catalog or Food Knowledge, and text that
//     LOOKS like a fact (a price, opening hours, an address, "hết món") is flagged and needs an explicit ack;
//   * only APPROVED items inside their validity window are active; DRAFT / REVIEW / RETIRED never are;
//   * an APPROVED version never changes — a change is a new version that supersedes it (approving it retires
//     the old one); nothing is deleted;
//   * approval is a PERSON's act ("ai:" / "model:" … actors cannot approve); nothing is published by AI;
//   * an INTERNAL_NOTE is internal, always — never customer-facing;
//   * every item has evidence: a verbatim quote from a stored source.
// FK-1 is storage + review only: nothing here is read by the GPT concierge yet.

export const TYPES = ["POLICY", "ADVICE_STYLE", "FAQ", "FOOD_RECOMMENDATION", "INTERNAL_NOTE"];
export const SCOPES = ["global", "region", "merchant", "product"];
const NON_PERSON = /^(?:ai|model|gpt|llm|bot|system|auto)(?:[:/\s-]|$)/i;

export class FounderKnowledgeError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
const fail = (code, message) => {
  throw new FounderKnowledgeError(code, message);
};

// Text that reads like an authoritative fact. It is not rejected (the founder may say "đừng hứa giá dưới 30k"),
// but it is flagged: approving it needs an explicit acknowledgement, and it never becomes a fact.
const FACT_LIKE = [
  ["PRICE", /\d{1,3}(?:[.,]\d{3})+\s*(?:đ|₫|vnd|đồng)?|\d+(?:[.,]\d+)?\s*(?:k|nghìn|ngàn|đ|₫|vnd|đồng|tr|triệu)(?![\p{L}])/iu],
  ["HOURS", /\b\d{1,2}\s*(?:h|g|giờ|:)\s*\d{0,2}\s*(?:-|–|đến|tới)\s*\d{1,2}\s*(?:h|g|giờ|:)?|\bmở cửa\b|\bđóng cửa\b|\bnghỉ (?:thứ|chủ nhật)/iu],
  ["ADDRESS", /\b(?:số\s*)?\d+[a-z]?\s*(?:\/\s*\d+\s*)?(?:đường|phố|đ\.)?\s*\p{Lu}[\p{L}]+(?:\s+\p{Lu}[\p{L}]+)+|\bđịa chỉ\b/u],
  ["AVAILABILITY", /(?<![\p{L}])(?:hết món|còn món|đang bán|ngừng bán|không bán nữa|bỏ món|đặt được|không đặt được)(?![\p{L}])/iu],
  ["ORDER_STATE", /(?<![\p{L}])(?:đơn (?:đã|đang|bị) (?:giao|hủy|huỷ|xác nhận)|trạng thái đơn)(?![\p{L}])/iu],
];
export function factLikeWarnings(text) {
  const t = nfc(String(text ?? ""));
  return FACT_LIKE.filter(([, re]) => re.test(t)).map(([code]) => code);
}

const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

export class FounderKnowledgeService {
  /** @param {{db: import("better-sqlite3").Database, rawRoot: string, now?: () => Date}} deps */
  constructor({ db, rawRoot, now = () => new Date() }) {
    this.db = db;
    this.repo = new FounderKnowledgeRepository(db);
    this.rawRoot = rawRoot;
    this.now = now;
  }

  // ------------------------------------------------------------------ sources (provenance)

  /** Stores founder text verbatim as an immutable raw file (by sha256) and registers it. Same text -> same source. */
  addTextSource({ text, submittedBy }) {
    if (!submittedBy) fail("ACTOR_REQUIRED", "who submitted the text is required");
    const content = nfc(String(text ?? ""));
    if (!content.trim()) fail("EMPTY_SOURCE", "the source text is empty");
    const hash = sha256(content);
    const existing = this.repo.sourceBySha(hash);
    if (existing) return existing;
    const rel = path.join("founder", `${hash}.txt`);
    const file = path.resolve(this.rawRoot, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (!fs.existsSync(file)) fs.writeFileSync(file, content, { flag: "wx" });
    return this.repo.source(this.repo.insertSource({ kind: "text", rawPath: rel, sha256: hash, submittedBy }));
  }

  /** A Knowledge Ingestion message as a source (text / caption; images and documents come later). */
  addIngestMessageSource({ ingestMessageId, submittedBy }) {
    if (this.repo.ingestMessageText(ingestMessageId) === null) fail("UNKNOWN_SOURCE", `no ingestion message ${ingestMessageId}`);
    return this.repo.source(this.repo.insertSource({ kind: "ingest_message", ingestMessageId, submittedBy }));
  }

  _sourceText(source) {
    if (source.raw_path) {
      const file = path.resolve(this.rawRoot, source.raw_path);
      if (!fs.existsSync(file)) fail("SOURCE_MISSING", `raw source ${source.raw_path} is missing`);
      const content = fs.readFileSync(file, "utf8");
      if (source.sha256 && sha256(content) !== source.sha256) fail("SOURCE_CHANGED", `raw source ${source.raw_path} no longer matches its sha256`);
      return content;
    }
    return this.repo.ingestMessageText(source.ingest_message_id) ?? "";
  }

  // ------------------------------------------------------------------ drafts

  _validate({ type, title, body, scope = "global", scopeRef = null, audience = null, priority = 50, validFrom = null, validTo = null }) {
    if (!TYPES.includes(type)) fail("INVALID_TYPE", `type must be one of ${TYPES.join(", ")}`);
    if (!String(title ?? "").trim()) fail("TITLE_REQUIRED", "title is required");
    if (!String(body ?? "").trim()) fail("BODY_REQUIRED", "body is required");
    if (!SCOPES.includes(scope)) fail("INVALID_SCOPE", `scope must be one of ${SCOPES.join(", ")}`);
    if ((scope === "global") !== (scopeRef === null || scopeRef === undefined || scopeRef === "")) fail("INVALID_SCOPE_REF", "global has no scope ref; region / merchant / product need one");
    if (scope === "region" && !this.db.prepare(`SELECT 1 FROM kb_regions WHERE id = ?`).get(scopeRef)) fail("UNKNOWN_REGION", `unknown region ${scopeRef}`);
    if ((scope === "merchant" || scope === "product") && !/^(?:cat|kb):\S+$/.test(scopeRef)) fail("INVALID_SCOPE_REF", `${scope} refs are "cat:<id>" (FOOD catalog) or "kb:<id>" (Food Knowledge)`);
    const aud = audience ?? (type === "INTERNAL_NOTE" ? "internal" : "customer");
    if (!["customer", "internal"].includes(aud)) fail("INVALID_AUDIENCE", "audience is customer or internal");
    if (type === "INTERNAL_NOTE" && aud !== "internal") fail("INTERNAL_NOTE_IS_INTERNAL", "an INTERNAL_NOTE is never customer-facing");
    if (!Number.isInteger(priority) || priority < 0 || priority > 100) fail("INVALID_PRIORITY", "priority is an integer 0..100");
    // stored as full ISO instants, so the active-window comparison is exact (never a mix of string formats)
    const iso = (v, name) => {
      if (v === null || v === undefined || v === "") return null;
      const d = new Date(v);
      if (Number.isNaN(d.getTime())) fail("INVALID_VALIDITY", `${name} is not a date`);
      return d.toISOString();
    };
    const from = iso(validFrom, "valid_from");
    const to = iso(validTo, "valid_to");
    if (from && to && !(to > from)) fail("INVALID_VALIDITY", "valid_to must be after valid_from");
    return { type, title: String(title).trim(), body: String(body).trim(), scope, scopeRef: scope === "global" ? null : scopeRef, audience: aud, priority, validFrom: from, validTo: to, warnings: factLikeWarnings(`${title}\n${body}`) };
  }

  /**
   * A new DRAFT with its evidence. evidence: [{ sourceId, quote, locator? }] — every quote must be in its source.
   * @returns {object} the item (see get())
   */
  createDraft({ author, evidence = [], ...fields }) {
    if (!author) fail("ACTOR_REQUIRED", "author is required");
    const v = this._validate(fields);
    const id = this.db.transaction(() => {
      const itemId = this.repo.insertItem({ ...v, author });
      this.repo.event(itemId, "created", author);
      for (const e of evidence) this._link(itemId, e, author);
      return itemId;
    })();
    return this.get(id);
  }

  /** The common case: the founder's own text is both the source and the body. */
  createFromText({ text, author, ...fields }) {
    const source = this.addTextSource({ text, submittedBy: author });
    return this.createDraft({ author, body: fields.body ?? text, ...fields, evidence: [{ sourceId: source.id, quote: String(text).trim(), locator: "whole text" }] });
  }

  editDraft(id, patch, actor) {
    const item = this._item(id);
    if (item.status !== "DRAFT") fail("NOT_EDITABLE", `only a DRAFT can be edited (this is ${item.status}); an approved version changes through a new version`);
    const v = this._validate({ type: item.type, title: item.title, body: item.body, scope: item.scope, scopeRef: item.scope_ref, audience: item.audience, priority: item.priority, validFrom: item.valid_from, validTo: item.valid_to, ...patch });
    this.db.transaction(() => {
      this.repo.updateDraft(id, v);
      this.repo.event(id, "edited", actor);
    })();
    return this.get(id);
  }

  linkEvidence(id, evidence, actor) {
    const item = this._item(id);
    if (!["DRAFT", "REVIEW"].includes(item.status)) fail("NOT_EDITABLE", `evidence is linked before approval (this is ${item.status})`);
    this.db.transaction(() => this._link(id, evidence, actor))();
    return this.get(id);
  }

  _link(itemId, { sourceId, quote, locator = null }, actor) {
    const source = this.repo.source(sourceId);
    if (!source) fail("UNKNOWN_SOURCE", `unknown source ${sourceId}`);
    const q = collapseWhitespace(nfc(String(quote ?? "")));
    if (!q) fail("QUOTE_REQUIRED", "evidence needs a verbatim quote");
    if (!collapseWhitespace(nfc(this._sourceText(source))).includes(q)) fail("QUOTE_NOT_IN_SOURCE", "the quote is not in its source");
    this.repo.insertEvidence({ itemId, sourceId, quote: q, locator });
    this.repo.event(itemId, "evidence_linked", actor, `source ${sourceId}`);
  }

  // ------------------------------------------------------------------ review / approval / retirement

  submitForReview(id, actor) {
    const item = this._item(id);
    if (item.status !== "DRAFT") fail("INVALID_TRANSITION", `${item.status} -> REVIEW is not allowed`);
    if (!this.repo.evidenceOf(id).length) fail("EVIDENCE_REQUIRED", "an item needs evidence before review");
    this.db.transaction(() => {
      this.repo.setStatus(id, "DRAFT", "REVIEW");
      this.repo.event(id, "submitted", actor);
    })();
    return this.get(id);
  }

  returnToDraft(id, actor, note = null) {
    const item = this._item(id);
    if (item.status !== "REVIEW") fail("INVALID_TRANSITION", `${item.status} -> DRAFT is not allowed`);
    this.db.transaction(() => {
      this.repo.setStatus(id, "REVIEW", "DRAFT");
      this.repo.event(id, "returned", actor, note);
    })();
    return this.get(id);
  }

  /** A person approves a version under review. A new version retires the approved one it supersedes. */
  approve(id, { by, ackWarnings = false, note = null }) {
    if (!by || NON_PERSON.test(String(by).trim())) fail("PERSON_REQUIRED", "approval is a person's decision (not an AI / system actor)");
    const item = this._item(id);
    if (item.status !== "REVIEW") fail("INVALID_TRANSITION", `${item.status} -> APPROVED is not allowed (submit it for review first)`);
    const warnings = JSON.parse(item.warnings_json);
    if (warnings.length && !ackWarnings) fail("WARNINGS_NOT_ACKNOWLEDGED", `the text looks like an authoritative fact (${warnings.join(", ")}); it will never be treated as one — acknowledge to approve`);
    if (!this.repo.evidenceOf(id).length) fail("EVIDENCE_REQUIRED", "an item needs evidence");
    this.db.transaction(() => {
      const current = this.repo.approvedInLineage(item.lineage_id);
      if (current && current.id !== id) {
        this.repo.retire(current.id, by, `superseded by #${id} (v${item.version})`);
        this.repo.event(current.id, "retired", by, `superseded by #${id}`);
      }
      this.repo.approve(id, by);
      this.repo.event(id, "approved", by, [note, warnings.length ? `acknowledged: ${warnings.join(", ")}` : null].filter(Boolean).join(" | ") || null);
    })();
    return this.get(id);
  }

  retire(id, { by, reason }) {
    if (!by) fail("ACTOR_REQUIRED", "who retires it is required");
    if (!String(reason ?? "").trim()) fail("REASON_REQUIRED", "a reason is required");
    const item = this._item(id);
    if (item.status === "RETIRED") fail("INVALID_TRANSITION", "already RETIRED");
    this.db.transaction(() => {
      this.repo.retire(id, by, reason);
      this.repo.event(id, "retired", by, reason);
    })();
    return this.get(id);
  }

  /** A new DRAFT version of an item (the approved version stays untouched until the new one is approved). */
  revise(id, patch, author) {
    if (!author) fail("ACTOR_REQUIRED", "author is required");
    const base = this._item(id);
    if (!["APPROVED", "RETIRED"].includes(base.status)) fail("INVALID_TRANSITION", `revise an APPROVED or RETIRED version (this is ${base.status}; edit the draft instead)`);
    const v = this._validate({ type: base.type, title: base.title, body: base.body, scope: base.scope, scopeRef: base.scope_ref, audience: base.audience, priority: base.priority, validFrom: base.valid_from, validTo: base.valid_to, ...patch });
    const newId = this.db.transaction(() => {
      const itemId = this.repo.insertItem({ ...v, author, lineageId: base.lineage_id, version: this.repo.maxVersion(base.lineage_id) + 1, supersedesId: base.id });
      this.repo.event(itemId, "created", author, `new version of #${base.id}`);
      // provenance carries over; new evidence can be added to the draft
      for (const e of this.repo.evidenceOf(base.id)) this.repo.insertEvidence({ itemId, sourceId: e.source_id, quote: e.quote, locator: e.locator });
      return itemId;
    })();
    return this.get(newId);
  }

  // ------------------------------------------------------------------ reads

  _item(id) {
    const item = this.repo.item(Number(id));
    if (!item) fail("NOT_FOUND", `no founder knowledge item #${id}`);
    return item;
  }

  get(id) {
    const item = this._item(id);
    return { ...this._shape(item), evidence: this.repo.evidenceOf(item.id), events: this.repo.events(item.id) };
  }

  list(filter = {}) {
    return this.repo.list(filter).map((i) => ({ ...this._shape(i), evidenceCount: this.repo.evidenceOf(i.id).length }));
  }

  /**
   * What is IN FORCE: APPROVED, inside its validity window. Customer audience by default — an INTERNAL_NOTE /
   * internal item is only returned when audience "internal" is asked for explicitly.
   * With a scope: the global items plus those of that exact scope ref.
   */
  getActiveApproved({ audience = "customer", scope = null, scopeRef = null, type = null, at = this.now() } = {}) {
    const iso = at instanceof Date ? at.toISOString() : String(at);
    return this.repo
      .approvedAt(iso)
      .filter((i) => (audience === "internal" ? true : i.audience === "customer" && i.type !== "INTERNAL_NOTE"))
      .filter((i) => !type || i.type === type)
      .filter((i) => !scope || i.scope === "global" || (i.scope === scope && i.scope_ref === scopeRef))
      .map((i) => this._shape(i));
  }

  _shape(i) {
    return {
      id: i.id,
      lineageId: i.lineage_id,
      version: i.version,
      supersedesId: i.supersedes_id,
      type: i.type,
      title: i.title,
      body: i.body,
      scope: i.scope,
      scopeRef: i.scope_ref,
      audience: i.audience,
      priority: i.priority,
      status: i.status,
      warnings: JSON.parse(i.warnings_json),
      author: i.author,
      approvedBy: i.approved_by,
      approvedAt: i.approved_at,
      retiredBy: i.retired_by,
      retiredAt: i.retired_at,
      retiredReason: i.retired_reason,
      validFrom: i.valid_from,
      validTo: i.valid_to,
      createdAt: i.created_at,
      updatedAt: i.updated_at,
    };
  }
}
