export class PaymentRepository {
  constructor(db) {
    this.db = db;
  }

  create({ orderId, provider, status, amount }) {
    const { lastInsertRowid } = this.db
      .prepare(`INSERT INTO payments (order_id, provider, status, amount) VALUES (?, ?, ?, ?)`)
      .run(orderId, provider, status, amount);
    return this.db.prepare(`SELECT * FROM payments WHERE id = ?`).get(lastInsertRowid);
  }

  listByOrder(orderId) {
    return this.db.prepare(`SELECT * FROM payments WHERE order_id = ? ORDER BY id`).all(orderId);
  }
}
