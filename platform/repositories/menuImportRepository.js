function parseRow(row) {
  if (!row) return row;
  return { ...row, draft: row.draft_json ? JSON.parse(row.draft_json) : null };
}

export class MenuImportRepository {
  constructor(db) {
    this.db = db;
  }

  getById(importId) {
    return parseRow(this.db.prepare(`SELECT * FROM merchant_menu_imports WHERE id = ?`).get(importId));
  }

  listByMerchant(merchantId, limit = 50) {
    return this.db
      .prepare(`SELECT * FROM merchant_menu_imports WHERE merchant_id = ? ORDER BY id DESC LIMIT ?`)
      .all(merchantId, limit)
      .map(parseRow);
  }

  create({ merchantId, sourceType, sourceReference, createdBy }) {
    const { lastInsertRowid } = this.db
      .prepare(
        `INSERT INTO merchant_menu_imports (merchant_id, source_type, source_reference, status, created_by)
         VALUES (?, ?, ?, 'PROCESSING', ?)`
      )
      .run(merchantId, sourceType, sourceReference ?? null, createdBy ?? null);
    return this.getById(lastInsertRowid);
  }

  setDraft(importId, status, draft) {
    this.db
      .prepare(`UPDATE merchant_menu_imports SET status = ?, draft_json = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(status, JSON.stringify(draft), importId);
    return this.getById(importId);
  }

  setStatus(importId, status) {
    this.db
      .prepare(`UPDATE merchant_menu_imports SET status = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(status, importId);
    return this.getById(importId);
  }

  setFailed(importId, errorMessage) {
    this.db
      .prepare(`UPDATE merchant_menu_imports SET status = 'FAILED', error_message = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(errorMessage, importId);
    return this.getById(importId);
  }

  setRejected(importId, reason) {
    this.db
      .prepare(`UPDATE merchant_menu_imports SET status = 'REJECTED', reject_reason = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(reason ?? null, importId);
    return this.getById(importId);
  }
}
