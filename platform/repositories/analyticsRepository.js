export class AnalyticsRepository {
  constructor(db) {
    this.db = db;
  }

  logSearch({ customerId, queryText, resultCount }) {
    this.db
      .prepare(`INSERT INTO search_events (customer_id, query_text, result_count) VALUES (?, ?, ?)`)
      .run(customerId || null, queryText, resultCount);
  }

  // event_type: SEARCH | MERCHANT_VIEW | PRODUCT_VIEW | ADD_TO_CART |
  // CHECKOUT_STARTED | ORDER_CREATED | ORDER_PAID | ORDER_COMPLETED
  logMerchantEvent({ merchantId, customerId, eventType, externalRef, payload }) {
    this.db
      .prepare(
        `INSERT INTO merchant_events (merchant_id, customer_id, event_type, external_ref, payload_json)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(merchantId || null, customerId || null, eventType, externalRef || null, payload ? JSON.stringify(payload) : null);
  }

  listByMerchant(merchantId, limit = 50) {
    return this.db
      .prepare(`SELECT * FROM merchant_events WHERE merchant_id = ? ORDER BY id DESC LIMIT ?`)
      .all(merchantId, limit);
  }
}
