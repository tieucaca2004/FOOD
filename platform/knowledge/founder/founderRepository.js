// Data access for Founder Knowledge (migration 006). SQL only — the rules live in the service.
// Every write goes through here; the triggers in 006 are the last line of defence.

export class FounderKnowledgeRepository {
  constructor(db) {
    this.db = db;
  }

  // ---- sources / evidence (append-only)
  sourceBySha(sha256) {
    return this.db.prepare(`SELECT * FROM kb_founder_sources WHERE sha256 = ?`).get(sha256) ?? null;
  }
  source(id) {
    return this.db.prepare(`SELECT * FROM kb_founder_sources WHERE id = ?`).get(id) ?? null;
  }
  insertSource({ kind, rawPath = null, sha256 = null, ingestMessageId = null, submittedBy }) {
    return this.db.prepare(`INSERT INTO kb_founder_sources (kind, raw_path, sha256, ingest_message_id, submitted_by) VALUES (?, ?, ?, ?, ?)`).run(kind, rawPath, sha256, ingestMessageId, submittedBy).lastInsertRowid;
  }
  insertEvidence({ itemId, sourceId, quote, locator = null }) {
    return this.db.prepare(`INSERT INTO kb_founder_evidence (item_id, source_id, quote, locator) VALUES (?, ?, ?, ?)`).run(itemId, sourceId, quote, locator).lastInsertRowid;
  }
  evidenceOf(itemId) {
    return this.db
      .prepare(
        `SELECT e.id, e.quote, e.locator, e.created_at, s.id AS source_id, s.kind, s.raw_path, s.sha256, s.ingest_message_id, s.submitted_by, s.received_at
         FROM kb_founder_evidence e JOIN kb_founder_sources s ON s.id = e.source_id WHERE e.item_id = ? ORDER BY e.id`
      )
      .all(itemId);
  }
  ingestMessageText(id) {
    const m = this.db.prepare(`SELECT text, caption FROM kb_ingest_messages WHERE id = ?`).get(id);
    return m ? [m.text, m.caption].filter(Boolean).join("\n") : null;
  }

  // ---- items
  item(id) {
    return this.db.prepare(`SELECT * FROM kb_founder_items WHERE id = ?`).get(id) ?? null;
  }
  insertItem(i) {
    const id = this.db
      .prepare(
        `INSERT INTO kb_founder_items (lineage_id, version, supersedes_id, type, title, body, scope, scope_ref, audience, priority, warnings_json, author, valid_from, valid_to)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(i.lineageId ?? null, i.version ?? 1, i.supersedesId ?? null, i.type, i.title, i.body, i.scope, i.scopeRef ?? null, i.audience, i.priority, JSON.stringify(i.warnings ?? []), i.author, i.validFrom ?? null, i.validTo ?? null).lastInsertRowid;
    if (!i.lineageId) this.db.prepare(`UPDATE kb_founder_items SET lineage_id = id WHERE id = ?`).run(id);
    return id;
  }
  updateDraft(id, p) {
    this.db
      .prepare(
        `UPDATE kb_founder_items SET title = ?, body = ?, scope = ?, scope_ref = ?, audience = ?, priority = ?, warnings_json = ?, valid_from = ?, valid_to = ?, updated_at = datetime('now')
         WHERE id = ? AND status = 'DRAFT'`
      )
      .run(p.title, p.body, p.scope, p.scopeRef ?? null, p.audience, p.priority, JSON.stringify(p.warnings ?? []), p.validFrom ?? null, p.validTo ?? null, id);
  }
  setStatus(id, from, to) {
    return this.db.prepare(`UPDATE kb_founder_items SET status = ?, updated_at = datetime('now') WHERE id = ? AND status = ?`).run(to, id, from).changes;
  }
  approve(id, by) {
    return this.db.prepare(`UPDATE kb_founder_items SET status = 'APPROVED', approved_by = ?, approved_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND status = 'REVIEW'`).run(by, id).changes;
  }
  retire(id, by, reason) {
    return this.db
      .prepare(`UPDATE kb_founder_items SET status = 'RETIRED', retired_by = ?, retired_at = datetime('now'), retired_reason = ?, updated_at = datetime('now') WHERE id = ? AND status != 'RETIRED'`)
      .run(by, reason, id).changes;
  }
  approvedInLineage(lineageId) {
    return this.db.prepare(`SELECT * FROM kb_founder_items WHERE lineage_id = ? AND status = 'APPROVED'`).get(lineageId) ?? null;
  }
  maxVersion(lineageId) {
    return this.db.prepare(`SELECT MAX(version) AS v FROM kb_founder_items WHERE lineage_id = ?`).get(lineageId).v ?? 0;
  }
  list({ status = null, type = null, audience = null, scope = null, lineageId = null } = {}) {
    const where = [];
    const args = [];
    for (const [col, v] of [["status", status], ["type", type], ["audience", audience], ["scope", scope], ["lineage_id", lineageId]]) {
      if (v !== null && v !== undefined) {
        where.push(`${col} = ?`);
        args.push(v);
      }
    }
    return this.db.prepare(`SELECT * FROM kb_founder_items ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY lineage_id, version`).all(...args);
  }
  approvedAt(atIso) {
    return this.db
      .prepare(`SELECT * FROM kb_founder_items WHERE status = 'APPROVED' AND (valid_from IS NULL OR valid_from <= ?) AND (valid_to IS NULL OR valid_to > ?) ORDER BY priority DESC, id`)
      .all(atIso, atIso);
  }

  // ---- audit trail (append-only)
  event(itemId, action, actor, note = null) {
    this.db.prepare(`INSERT INTO kb_founder_events (item_id, action, actor, note) VALUES (?, ?, ?, ?)`).run(itemId, action, actor, note);
  }
  events(itemId) {
    return this.db.prepare(`SELECT action, actor, note, at FROM kb_founder_events WHERE item_id = ? ORDER BY id`).all(itemId);
  }
}
