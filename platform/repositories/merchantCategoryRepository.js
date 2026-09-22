export class MerchantCategoryRepository {
  constructor(db) {
    this.db = db;
  }

  listByMerchant(merchantId) {
    return this.db.prepare(`SELECT * FROM merchant_categories WHERE merchant_id = ? ORDER BY sort_order, id`).all(merchantId);
  }

  create(merchantId, name, sortOrder = 0) {
    const { lastInsertRowid } = this.db
      .prepare(`INSERT INTO merchant_categories (merchant_id, name, sort_order) VALUES (?, ?, ?)`)
      .run(merchantId, name, sortOrder);
    return this.db.prepare(`SELECT * FROM merchant_categories WHERE id = ?`).get(lastInsertRowid);
  }
}
