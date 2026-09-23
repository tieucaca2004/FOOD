// Merchant-side identity anchor for Phase 7 authentication. merchant_users
// (migration 001) existed but was never read from or written to by any
// repository before now — this completes that missing repository layer.
export class MerchantUserRepository {
  constructor(db) {
    this.db = db;
  }

  getById(id) {
    return this.db.prepare(`SELECT * FROM merchant_users WHERE id = ?`).get(id);
  }

  findOwnerByMerchant(merchantId) {
    return this.db.prepare(`SELECT * FROM merchant_users WHERE merchant_id = ? AND role = 'owner' LIMIT 1`).get(merchantId);
  }

  findByApiKeyHash(hash) {
    return this.db.prepare(`SELECT * FROM merchant_users WHERE api_key_hash = ?`).get(hash);
  }

  create({ merchantId, name, role = "owner" }) {
    const { lastInsertRowid } = this.db
      .prepare(`INSERT INTO merchant_users (merchant_id, name, role) VALUES (?, ?, ?)`)
      .run(merchantId, name || null, role);
    return this.getById(lastInsertRowid);
  }

  setApiKeyHash(id, hash) {
    this.db.prepare(`UPDATE merchant_users SET api_key_hash = ? WHERE id = ?`).run(hash, id);
    return this.getById(id);
  }
}
