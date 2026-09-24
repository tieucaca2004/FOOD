import { generateOrderCode } from "../domain/orderCode.js";
import { CART_LIFECYCLE_STATUS } from "../domain/cartLifecycle.js";
import { platformConfig } from "../config.js";

export class OrderCodeConflictError extends Error {}

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

  // Snapshots cart items into a new CREATED order AND retires the cart
  // (Phase 6.x — see platform/domain/cartLifecycle.js) inside ONE
  // transaction — order creation and cart retirement are atomic: a
  // rollback here leaves no order and the cart still ACTIVE; a commit
  // leaves the order created and the cart no longer ACTIVE. subtotal/
  // total are computed here, never trusted from a caller (Phase 6
  // approved decision F). The per-day order-code sequence is counted
  // inside the same transaction, same concurrency-safe technique A
  // Tiểu's own OrderRepository.createDraftFromCart already uses.
  //
  // cart_id has a DB-level partial UNIQUE index (orders(cart_id) WHERE
  // status != 'CANCELLED', migration 007) — the DB is the final
  // concurrency authority for "at most one active order per cart"
  // (approved decision #2, unchanged by Phase 6.x — see class doc). If
  // that constraint is violated (a second concurrent confirm on the same
  // cart), this returns null rather than throwing a raw driver error —
  // the caller (OrderService) maps that to a clean domain error.
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

      // Retire the cart in the same transaction as the order it just
      // became — this is what makes "one cart converts to at most one
      // order" (the UNIQUE index above) compatible with "a customer can
      // order from the same merchant again" (a brand-new ACTIVE cart).
      // `AND status = 'ACTIVE'` is defense-in-depth, not load-bearing —
      // the orders UNIQUE index above is what actually prevents a double
      // conversion; this just avoids writing a redundant UPDATE if it
      // somehow weren't still ACTIVE. The item rows on a converted cart
      // are left as-is (not cleared) — a converted cart is a retired
      // historical record, not a resource to keep tidy for reuse; it is
      // never reachable through CartService again either way (frozen
      // CartService._ownedCart rejects any status other than ACTIVE).
      this.db
        .prepare(`UPDATE merchant_carts SET status = ?, updated_at = datetime('now') WHERE id = ? AND status = 'ACTIVE'`)
        .run(CART_LIFECYCLE_STATUS.CONVERTED, cartId);

      return this.getById(orderId);
    });

    try {
      return tx();
    } catch (err) {
      const message = String(err.message);
      if (message.includes("UNIQUE constraint failed: orders.cart_id")) return null; // an active (non-CANCELLED) order already exists for this cart
      if (message.includes("UNIQUE constraint failed: orders.order_code")) {
        // Nothing was written (the transaction rolled back) and the cart is
        // still ACTIVE, so the caller can safely retry.
        throw new OrderCodeConflictError(`Generated order code collided with an existing order (cart ${cartId})`);
      }
      throw err;
    }
  }

  setStatus(orderId, status) {
    this.db.prepare(`UPDATE orders SET status = ?, updated_at = datetime('now') WHERE id = ?`).run(status, orderId);
    return this.getById(orderId);
  }
}
