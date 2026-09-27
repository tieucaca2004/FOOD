// Persistence for learned product language (migration 010). Pure data
// access — the learning rules live in ProductLanguageService.
export class ProductAliasRepository {
  constructor(db) {
    this.db = db;
  }

  get(merchantId, normalizedAlias, productId) {
    return (
      this.db
        .prepare(`SELECT * FROM merchant_product_aliases WHERE merchant_id = ? AND normalized_alias = ? AND product_id = ?`)
        .get(merchantId, normalizedAlias, productId) || null
    );
  }

  listByPhrase(merchantId, normalizedAlias) {
    return this.db
      .prepare(`SELECT * FROM merchant_product_aliases WHERE merchant_id = ? AND normalized_alias = ?`)
      .all(merchantId, normalizedAlias);
  }

  listByMerchant(merchantId) {
    return this.db
      .prepare(`SELECT * FROM merchant_product_aliases WHERE merchant_id = ? ORDER BY product_id, confidence DESC, observed_count DESC`)
      .all(merchantId);
  }

  // Creates the row on first sight (INSERT OR IGNORE keeps the UNIQUE
  // key as the only duplicate guard) and returns it.
  ensure(merchantId, productId, alias, normalizedAlias) {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO merchant_product_aliases (merchant_id, product_id, alias, normalized_alias) VALUES (?, ?, ?, ?)`
      )
      .run(merchantId, productId, alias, normalizedAlias);
    return this.get(merchantId, normalizedAlias, productId);
  }

  saveCounts(id, { observed_count, confirmed_count, rejected_count, confidence, status }) {
    this.db
      .prepare(
        `UPDATE merchant_product_aliases
         SET observed_count = ?, confirmed_count = ?, rejected_count = ?, confidence = ?, status = ?,
             last_seen_at = datetime('now'), updated_at = datetime('now')
         WHERE id = ?`
      )
      .run(observed_count, confirmed_count, rejected_count, confidence, status, id);
  }

  setEventConfidenceAfter(eventId, confidence) {
    this.db.prepare(`UPDATE product_alias_events SET confidence_after = ? WHERE id = ?`).run(confidence, eventId);
  }

  insertEvent(event) {
    return this.db
      .prepare(
        `INSERT INTO product_alias_events
           (merchant_id, customer_id, product_id, normalized_phrase, resolution_source, signal, confidence_before, confidence_after)
         VALUES (@merchant_id, @customer_id, @product_id, @normalized_phrase, @resolution_source, @signal, @confidence_before, @confidence_after)`
      )
      .run(event).lastInsertRowid;
  }

  countDistinctConfirmingCustomers(merchantId, normalizedAlias, productId) {
    return this.db
      .prepare(
        `SELECT COUNT(DISTINCT customer_id) AS n FROM product_alias_events
         WHERE merchant_id = ? AND normalized_phrase = ? AND product_id = ? AND signal = 'confirmed' AND customer_id IS NOT NULL`
      )
      .get(merchantId, normalizedAlias, productId).n;
  }

  pruneEventsOlderThan(days) {
    return this.db.prepare(`DELETE FROM product_alias_events WHERE created_at < datetime('now', ?)`).run(`-${days} days`).changes;
  }
}
