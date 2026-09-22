export class MerchantCategoryRepository {
  constructor(db) {
    this.db = db;
  }

  listByMerchant(merchantId) {
    return this.db.prepare(`SELECT * FROM merchant_categories WHERE merchant_id = ? ORDER BY sort_order, id`).all(merchantId);
  }

  getById(id) {
    return this.db.prepare(`SELECT * FROM merchant_categories WHERE id = ?`).get(id);
  }

  create(merchantId, name, sortOrder = 0) {
    const { lastInsertRowid } = this.db
      .prepare(`INSERT INTO merchant_categories (merchant_id, name, sort_order) VALUES (?, ?, ?)`)
      .run(merchantId, name, sortOrder);
    return this.db.prepare(`SELECT * FROM merchant_categories WHERE id = ?`).get(lastInsertRowid);
  }

  update(id, patch) {
    const current = this.getById(id);
    this.db
      .prepare(`UPDATE merchant_categories SET name = ?, sort_order = ? WHERE id = ?`)
      .run(patch.name ?? current.name, patch.sortOrder ?? current.sort_order, id);
    return this.getById(id);
  }

  delete(id) {
    this.db.prepare(`DELETE FROM merchant_categories WHERE id = ?`).run(id);
  }
}
