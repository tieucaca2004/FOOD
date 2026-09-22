export class CustomerRepository {
  constructor(db) {
    this.db = db;
  }

  findByZaloUserId(zaloUserId) {
    return this.db.prepare(`SELECT * FROM customers WHERE zalo_user_id = ?`).get(zaloUserId);
  }

  findById(id) {
    return this.db.prepare(`SELECT * FROM customers WHERE id = ?`).get(id);
  }

  create({ zaloUserId, displayName, phone }) {
    const { lastInsertRowid } = this.db
      .prepare(
        `INSERT INTO customers (zalo_user_id, display_name, phone) VALUES (?, ?, ?)`
      )
      .run(zaloUserId, displayName || null, phone || null);
    return this.findById(lastInsertRowid);
  }

  updateProfile(id, { displayName, phone }) {
    this.db
      .prepare(
        `UPDATE customers SET
           display_name = COALESCE(?, display_name),
           phone = COALESCE(?, phone),
           updated_at = datetime('now')
         WHERE id = ?`
      )
      .run(displayName ?? null, phone ?? null, id);
    return this.findById(id);
  }
}
