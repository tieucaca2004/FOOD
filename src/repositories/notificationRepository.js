export class NotificationRepository {
  constructor(db) {
    this.db = db;
  }

  create({ orderId, channel, status, payload, error }) {
    const { lastInsertRowid } = this.db
      .prepare(
        `INSERT INTO notifications (order_id, channel, status, payload, error) VALUES (?, ?, ?, ?, ?)`
      )
      .run(orderId ?? null, channel, status, payload ? JSON.stringify(payload) : null, error || null);
    return this.db.prepare(`SELECT * FROM notifications WHERE id = ?`).get(lastInsertRowid);
  }

  listByOrder(orderId) {
    return this.db.prepare(`SELECT * FROM notifications WHERE order_id = ? ORDER BY id`).all(orderId);
  }
}
