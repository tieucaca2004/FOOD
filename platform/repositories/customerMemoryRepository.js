// Layer 1 — Customer Memory storage (migration 011). Plain data access,
// always scoped by customer_id; rules live in CustomerMemoryService.
export class CustomerMemoryRepository {
  constructor(db) {
    this.db = db;
  }

  // --- preferences -------------------------------------------------------------------

  getPreference(customerId, { scope, merchantId = null, productId = null, attribute }) {
    return (
      this.db
        .prepare(
          `SELECT * FROM customer_preferences
           WHERE customer_id = ? AND scope = ? AND IFNULL(merchant_id, '') = IFNULL(?, '') AND IFNULL(product_id, 0) = IFNULL(?, 0) AND attribute = ?`
        )
        .get(customerId, scope, merchantId, productId, attribute) || null
    );
  }

  insertPreference(p) {
    this.db
      .prepare(
        `INSERT INTO customer_preferences
           (customer_id, merchant_id, product_id, scope, attribute, value, label, confidence, evidence_count, contradiction_count, source, status)
         VALUES (@customer_id, @merchant_id, @product_id, @scope, @attribute, @value, @label, @confidence, @evidence_count, @contradiction_count, @source, @status)`
      )
      .run({
        customer_id: p.customer_id,
        merchant_id: p.merchant_id ?? null,
        product_id: p.product_id ?? null,
        scope: p.scope,
        attribute: p.attribute,
        value: p.value,
        label: p.label,
        confidence: p.confidence,
        evidence_count: p.evidence_count,
        contradiction_count: p.contradiction_count,
        source: p.source,
        status: p.status,
      });
  }

  updatePreference(id, p) {
    this.db
      .prepare(
        `UPDATE customer_preferences
         SET value = @value, label = @label, confidence = @confidence, evidence_count = @evidence_count,
             contradiction_count = @contradiction_count, source = @source, status = @status,
             last_confirmed_at = datetime('now'), updated_at = datetime('now')
         WHERE id = @id`
      )
      .run({
        id,
        value: p.value,
        label: p.label,
        confidence: p.confidence,
        evidence_count: p.evidence_count,
        contradiction_count: p.contradiction_count,
        source: p.source,
        status: p.status,
      });
  }

  // Preferences that may apply at this merchant: global, this merchant's,
  // and product-scoped ones for this merchant.
  listApplicable(customerId, merchantId) {
    return this.db
      .prepare(
        `SELECT * FROM customer_preferences
         WHERE customer_id = ? AND status != 'RETIRED'
           AND (scope = 'global' OR merchant_id = ?)`
      )
      .all(customerId, merchantId);
  }

  listPreferences(customerId) {
    return this.db.prepare(`SELECT * FROM customer_preferences WHERE customer_id = ? ORDER BY scope, attribute`).all(customerId);
  }

  // --- addresses --------------------------------------------------------------------------

  listAddresses(customerId) {
    return this.db
      .prepare(`SELECT * FROM customer_addresses WHERE customer_id = ? ORDER BY is_default DESC, usage_count DESC, last_used_at DESC`)
      .all(customerId);
  }

  getAddress(customerId, normalizedAddress) {
    return this.db.prepare(`SELECT * FROM customer_addresses WHERE customer_id = ? AND normalized_address = ?`).get(customerId, normalizedAddress) || null;
  }

  insertAddress({ customerId, label, address, normalizedAddress, isDefault, usageCount }) {
    this.db
      .prepare(
        `INSERT INTO customer_addresses (customer_id, label, address, normalized_address, is_default, usage_count, last_used_at)
         VALUES (?, ?, ?, ?, ?, ?, CASE WHEN ? > 0 THEN datetime('now') ELSE NULL END)`
      )
      .run(customerId, label, address, normalizedAddress, isDefault ? 1 : 0, usageCount, usageCount);
  }

  touchAddress(id, { label, used }) {
    this.db
      .prepare(
        `UPDATE customer_addresses
         SET label = COALESCE(?, label),
             usage_count = usage_count + ?,
             last_used_at = CASE WHEN ? > 0 THEN datetime('now') ELSE last_used_at END,
             updated_at = datetime('now')
         WHERE id = ?`
      )
      .run(label, used ? 1 : 0, used ? 1 : 0, id);
  }

  // --- order references ------------------------------------------------------------------------

  // true when a new reference was stored (false = this order was already known)
  insertOrderRef({ customerId, merchantId, orderRef, instructions }) {
    return (
      this.db
        .prepare(`INSERT OR IGNORE INTO customer_order_refs (customer_id, merchant_id, order_ref, instructions_json) VALUES (?, ?, ?, ?)`)
        .run(customerId, merchantId, orderRef, JSON.stringify(instructions || [])).changes > 0
    );
  }

  listOrderRefs(customerId, merchantId, limit = 10) {
    return this.db
      .prepare(`SELECT * FROM customer_order_refs WHERE customer_id = ? AND merchant_id = ? ORDER BY ordered_at DESC, id DESC LIMIT ?`)
      .all(customerId, merchantId, limit)
      .map((r) => ({ ...r, instructions: JSON.parse(r.instructions_json || "[]") }));
  }
}
