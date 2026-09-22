// Orders for "generic" (data-driven) merchants — merchants with a custom
// module (like A Tiểu) keep their own order-of-record in their own DB;
// this table is never used for them. See platform/db/migrations/001_platform_init.sql.
export class PlatformOrderRepository {
  constructor(db) {
    this.db = db;
  }

  getById(id) {
    return this.db.prepare(`SELECT * FROM orders WHERE id = ?`).get(id);
  }

  listItems(orderId) {
    return this.db.prepare(`SELECT * FROM order_items WHERE order_id = ? ORDER BY id`).all(orderId);
  }

  createDraft({ orderCode, merchantId, customerId, items }) {
    const tx = this.db.transaction(() => {
      const subtotal = items.reduce((sum, i) => sum + i.unit_price * i.quantity, 0);
      const { lastInsertRowid: orderId } = this.db
        .prepare(
          `INSERT INTO orders (order_code, merchant_id, customer_id, status, subtotal, total)
           VALUES (?, ?, ?, 'DRAFT', ?, ?)`
        )
        .run(orderCode, merchantId, customerId, subtotal, subtotal);

      const insertItem = this.db.prepare(
        `INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity, line_total)
         VALUES (?, ?, ?, ?, ?, ?)`
      );
      for (const item of items) {
        insertItem.run(orderId, item.product_id, item.product_name, item.unit_price, item.quantity, item.unit_price * item.quantity);
      }
      return this.getById(orderId);
    });
    return tx();
  }

  setStatus(orderId, status) {
    this.db.prepare(`UPDATE orders SET status = ?, updated_at = datetime('now') WHERE id = ?`).run(status, orderId);
    return this.getById(orderId);
  }
}
