export class PlatformCustomerRepository {
  constructor(db) {
    this.db = db;
  }

  findByZaloUserId(zaloUserId) {
    return this.db.prepare(`SELECT * FROM platform_customers WHERE zalo_user_id = ?`).get(zaloUserId);
  }

  findById(id) {
    return this.db.prepare(`SELECT * FROM platform_customers WHERE id = ?`).get(id);
  }

  create({ zaloUserId, displayName }) {
    const { lastInsertRowid } = this.db
      .prepare(`INSERT INTO platform_customers (zalo_user_id, display_name) VALUES (?, ?)`)
      .run(zaloUserId, displayName || null);
    return this.findById(lastInsertRowid);
  }

  updateDisplayName(id, displayName) {
    this.db
      .prepare(`UPDATE platform_customers SET display_name = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(displayName, id);
    return this.findById(id);
  }
}
