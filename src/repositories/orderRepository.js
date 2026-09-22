import { generateOrderCode } from "../domain/orderCode.js";

export class OrderRepository {
  constructor(db) {
    this.db = db;
  }

  getById(id) {
    return this.db.prepare(`SELECT * FROM orders WHERE id = ?`).get(id);
  }

  getByCode(code) {
    return this.db.prepare(`SELECT * FROM orders WHERE order_code = ?`).get(code);
  }

  findOpenByCart(cartId) {
    return this.db
      .prepare(
        `SELECT * FROM orders WHERE cart_id = ? AND status NOT IN ('CANCELLED','COMPLETED') ORDER BY id DESC LIMIT 1`
      )
      .get(cartId);
  }

  listItems(orderId) {
    return this.db.prepare(`SELECT * FROM order_items WHERE order_id = ? ORDER BY id`).all(orderId);
  }

  listEvents(orderId) {
    return this.db.prepare(`SELECT * FROM order_events WHERE order_id = ? ORDER BY id`).all(orderId);
  }

  listByCustomer(customerId, limit = 10) {
    return this.db
      .prepare(`SELECT * FROM orders WHERE customer_id = ? ORDER BY id DESC LIMIT ?`)
      .all(customerId, limit);
  }

  // Creates a DRAFT order snapshotting current cart items (price/name at
  // this instant) inside one transaction — line totals are computed here,
  // never trusted from a caller.
  createDraftFromCart({ customerId, cartId, cartItems }) {
    const tx = this.db.transaction(() => {
      const today = new Date();
      const y = today.getFullYear();
      const m = String(today.getMonth() + 1).padStart(2, "0");
      const d = String(today.getDate()).padStart(2, "0");
      const countToday = this.db
        .prepare(`SELECT COUNT(*) AS n FROM orders WHERE order_code LIKE ?`)
        .get(`%-${y}${m}${d}-%`).n;
      const orderCode = generateOrderCode(today, countToday + 1);

      const subtotal = cartItems.reduce((sum, i) => sum + i.unit_price * i.quantity, 0);

      const { lastInsertRowid: orderId } = this.db
        .prepare(
          `INSERT INTO orders (order_code, customer_id, cart_id, status, subtotal, delivery_fee, total)
           VALUES (?, ?, ?, 'DRAFT', ?, 0, ?)`
        )
        .run(orderCode, customerId, cartId, subtotal, subtotal);

      const insertItem = this.db.prepare(
        `INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity, line_total)
         VALUES (?, ?, ?, ?, ?, ?)`
      );
      for (const item of cartItems) {
        insertItem.run(orderId, item.product_id, item.product_name, item.unit_price, item.quantity, item.unit_price * item.quantity);
      }

      this.db
        .prepare(`INSERT INTO order_events (order_id, from_status, to_status, note) VALUES (?, NULL, 'DRAFT', 'created from cart')`)
        .run(orderId);

      return this.getById(orderId);
    });
    return tx();
  }

  updateCheckoutFields(orderId, fields) {
    const current = this.getById(orderId);
    this.db
      .prepare(
        `UPDATE orders SET
           fulfillment_type = COALESCE(?, fulfillment_type),
           customer_name = COALESCE(?, customer_name),
           customer_phone = COALESCE(?, customer_phone),
           delivery_address = COALESCE(?, delivery_address),
           delivery_fee = ?,
           total = subtotal + ?,
           updated_at = datetime('now')
         WHERE id = ?`
      )
      .run(
        fields.fulfillmentType ?? null,
        fields.customerName ?? null,
        fields.customerPhone ?? null,
        fields.deliveryAddress ?? null,
        fields.deliveryFee ?? current.delivery_fee,
        fields.deliveryFee ?? current.delivery_fee,
        orderId
      );
    return this.getById(orderId);
  }

  transitionStatus(orderId, fromStatus, toStatus, note) {
    const tx = this.db.transaction(() => {
      this.db
        .prepare(`UPDATE orders SET status = ?, updated_at = datetime('now') WHERE id = ? AND status = ?`)
        .run(toStatus, orderId, fromStatus);
      this.db
        .prepare(`INSERT INTO order_events (order_id, from_status, to_status, note) VALUES (?, ?, ?, ?)`)
        .run(orderId, fromStatus, toStatus, note || null);
      return this.getById(orderId);
    });
    return tx();
  }
}
