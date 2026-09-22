import { generateOrderCode } from "../domain/orderCode.js";
import { platformConfig } from "../config.js";

// Orders for "generic" (data-driven) merchants — merchants with a custom
// module (like A Tiểu) keep their own order-of-record in their own DB;
// this table is never used for them. See platform/db/migrations/001_platform_init.sql.
//
// Phase 6: this is a lead/order-relay record, not a financial transaction
// the platform owns — see platform/services/orderService.js for the
// business rules (validation, snapshot, dispatch) layered on top of this
// repository's plain SQL.
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

  listByCustomer(customerId) {
    return this.db.prepare(`SELECT * FROM orders WHERE customer_id = ? ORDER BY id DESC`).all(customerId);
  }

  // Snapshots cart items into a new CREATED order inside one transaction —
  // subtotal/total are computed here, never trusted from a caller (Phase
  // 6 approved decision F). The per-day order-code sequence is counted
  // inside the same transaction, same concurrency-safe technique A
  // Tiểu's own OrderRepository.createDraftFromCart already uses.
  //
  // cart_id has a DB-level partial UNIQUE index (orders(cart_id) WHERE
  // status != 'CANCELLED', migration 007) — the DB is the final
  // concurrency authority for "at most one active order per cart"
  // (approved decision #2). If that constraint is violated (a second
  // concurrent confirm on the same cart), this returns null rather than
  // throwing a raw driver error — the caller (OrderService) maps that to
  // a clean domain error.
  createDraft({ merchantId, customerId, cartId, items }) {
    const tx = this.db.transaction(() => {
      const today = new Date();
      const y = today.getFullYear();
      const m = String(today.getMonth() + 1).padStart(2, "0");
      const d = String(today.getDate()).padStart(2, "0");
      const countToday = this.db
        .prepare(`SELECT COUNT(*) AS n FROM orders WHERE order_code LIKE ?`)
        .get(`${platformConfig.orderCodePrefix}-${y}${m}${d}-%`).n;
      const orderCode = generateOrderCode(today, countToday + 1, platformConfig.orderCodePrefix);

      const subtotal = items.reduce((sum, i) => sum + i.unit_price * i.quantity, 0);
      const { lastInsertRowid: orderId } = this.db
        .prepare(
          `INSERT INTO orders (order_code, merchant_id, customer_id, cart_id, status, subtotal, total)
           VALUES (?, ?, ?, ?, 'CREATED', ?, ?)`
        )
        .run(orderCode, merchantId, customerId, cartId, subtotal, subtotal);

      const insertItem = this.db.prepare(
        `INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity, line_total)
         VALUES (?, ?, ?, ?, ?, ?)`
      );
      for (const item of items) {
        insertItem.run(orderId, item.product_id, item.product_name, item.unit_price, item.quantity, item.unit_price * item.quantity);
      }
      return this.getById(orderId);
    });

    try {
      return tx();
    } catch (err) {
      if (String(err.message).includes("UNIQUE")) return null; // an active (non-CANCELLED) order already exists for this cart
      throw err;
    }
  }

  setStatus(orderId, status) {
    this.db.prepare(`UPDATE orders SET status = ?, updated_at = datetime('now') WHERE id = ?`).run(status, orderId);
    return this.getById(orderId);
  }
}
