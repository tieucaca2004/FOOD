export class DeliveryRepository {
  constructor(db) {
    this.db = db;
  }

  create({ orderId, provider, status, quoteAmount }) {
    const { lastInsertRowid } = this.db
      .prepare(`INSERT INTO deliveries (order_id, provider, status, quote_amount) VALUES (?, ?, ?, ?)`)
      .run(orderId, provider, status, quoteAmount ?? null);
    return this.db.prepare(`SELECT * FROM deliveries WHERE id = ?`).get(lastInsertRowid);
  }

  listByOrder(orderId) {
    return this.db.prepare(`SELECT * FROM deliveries WHERE order_id = ? ORDER BY id`).all(orderId);
  }
}
