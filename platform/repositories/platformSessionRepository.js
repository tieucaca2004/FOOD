function parseSession(row) {
  if (!row) return row;
  return { ...row, lastSearchResults: row.last_search_results_json ? JSON.parse(row.last_search_results_json) : [] };
}

export class PlatformSessionRepository {
  constructor(db) {
    this.db = db;
  }

  getActiveByCustomer(customerId) {
    return parseSession(
      this.db.prepare(`SELECT * FROM platform_sessions WHERE customer_id = ? ORDER BY id DESC LIMIT 1`).get(customerId)
    );
  }

  create(customerId) {
    const { lastInsertRowid } = this.db
      .prepare(`INSERT INTO platform_sessions (customer_id) VALUES (?)`)
      .run(customerId);
    return this.getById(lastInsertRowid);
  }

  getById(id) {
    return parseSession(this.db.prepare(`SELECT * FROM platform_sessions WHERE id = ?`).get(id));
  }

  update(id, patch) {
    const current = this.getById(id);
    const merged = {
      context: patch.context ?? current.context,
      active_merchant_id: patch.activeMerchantId === undefined ? current.active_merchant_id : patch.activeMerchantId,
      last_search_query: patch.lastSearchQuery === undefined ? current.last_search_query : patch.lastSearchQuery,
      last_search_results_json:
        patch.lastSearchResults === undefined ? current.last_search_results_json : JSON.stringify(patch.lastSearchResults),
    };
    this.db
      .prepare(
        `UPDATE platform_sessions SET
           context = ?, active_merchant_id = ?, last_search_query = ?, last_search_results_json = ?,
           last_interaction_at = datetime('now'), updated_at = datetime('now')
         WHERE id = ?`
      )
      .run(merged.context, merged.active_merchant_id, merged.last_search_query, merged.last_search_results_json, id);
    return this.getById(id);
  }

  enterMerchantContext(id, merchantId) {
    return this.update(id, { context: "merchant", activeMerchantId: merchantId });
  }

  returnToPlatform(id) {
    return this.update(id, { context: "platform", activeMerchantId: null });
  }
}
