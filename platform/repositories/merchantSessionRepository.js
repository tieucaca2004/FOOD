export class MerchantSessionRepository {
  constructor(db) {
    this.db = db;
  }

  open({ platformSessionId, merchantId, entrySource, searchQuery, selectedProductRef }) {
    const { lastInsertRowid } = this.db
      .prepare(
        `INSERT INTO merchant_sessions (platform_session_id, merchant_id, entry_source, search_query, selected_product_ref)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(platformSessionId, merchantId, entrySource || "platform_search", searchQuery || null, selectedProductRef || null);
    return this.db.prepare(`SELECT * FROM merchant_sessions WHERE id = ?`).get(lastInsertRowid);
  }

  closeOpenForSession(platformSessionId) {
    this.db
      .prepare(`UPDATE merchant_sessions SET closed_at = datetime('now') WHERE platform_session_id = ? AND closed_at IS NULL`)
      .run(platformSessionId);
  }

  listByPlatformSession(platformSessionId) {
    return this.db
      .prepare(`SELECT * FROM merchant_sessions WHERE platform_session_id = ? ORDER BY id`)
      .all(platformSessionId);
  }
}
