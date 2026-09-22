// One menu record per merchant (UNIQUE merchant_id) — the entity behind
// createMenu/updateMenu/publishMenu/archiveMenu. Categories/products still
// reference merchant_id directly, not this row's id.
export class MerchantMenuRepository {
  constructor(db) {
    this.db = db;
  }

  getByMerchant(merchantId) {
    return this.db.prepare(`SELECT * FROM merchant_menus WHERE merchant_id = ?`).get(merchantId);
  }

  create(merchantId, { name = null, status = "DRAFT" } = {}) {
    const { lastInsertRowid } = this.db
      .prepare(`INSERT INTO merchant_menus (merchant_id, name, status) VALUES (?, ?, ?)`)
      .run(merchantId, name, status);
    return this.db.prepare(`SELECT * FROM merchant_menus WHERE id = ?`).get(lastInsertRowid);
  }

  updateStatus(merchantId, status) {
    this.db
      .prepare(`UPDATE merchant_menus SET status = ?, updated_at = datetime('now') WHERE merchant_id = ?`)
      .run(status, merchantId);
    return this.getByMerchant(merchantId);
  }

  update(merchantId, patch) {
    const current = this.getByMerchant(merchantId);
    this.db
      .prepare(`UPDATE merchant_menus SET name = ?, status = ?, updated_at = datetime('now') WHERE merchant_id = ?`)
      .run(patch.name !== undefined ? patch.name : current.name, patch.status ?? current.status, merchantId);
    return this.getByMerchant(merchantId);
  }
}
