import { ORDER_STATUS, assertTransition } from "../domain/orderStateMachine.js";

/**
 * Phase 7: Merchant Order Visibility / Receive boundary — the merchant
 * side of the same `orders`/`order_items` tables OrderService (Phase 6,
 * frozen) already owns for the customer side. Reuses the domain state
 * machine (platform/domain/orderStateMachine.js) and the platform's
 * shared DB connection (exposed via repos.orders.db, same reuse pattern
 * already established by Phase 6.x's cart retirement and Phase 4's
 * MenuService.applyPublishedDraft) — deliberately does NOT modify
 * orderService.js/orderRepository.js, since nothing here requires it.
 *
 * BUSINESS MODEL (unchanged — see orderService.js class doc): the
 * platform is a lead/order-relay layer. This class only ever answers
 * "what did this merchant's customers order" and "has this merchant
 * seen/acknowledged this order" — never payment, never delivery.
 *
 * DISPATCH SEMANTICS (Phase 7 architecture decision, documented before
 * implementation as required): "merchant visibility" and "merchant
 * receipt" are collapsed into ONE explicit authenticated action —
 * receiveOrder() — rather than two separate API calls. Both real state
 * machine transitions (CREATED -> SENT_TO_MERCHANT -> RECEIVED) are
 * still genuinely applied and independently validated via
 * assertTransition, not skipped or faked; nothing is marked
 * SENT_TO_MERCHANT merely because it exists in the DB, and nothing is
 * marked RECEIVED without an authenticated merchant explicitly calling
 * this method for that exact order. The reasoning: in this platform's
 * actual UX, "the merchant looked at the order list" and "the merchant
 * acknowledges this specific order" have no meaningfully different
 * real-world evidence — a passive GET is not stronger evidence of
 * acknowledgment than an explicit action, and a side-effecting GET
 * would be a worse API design. A future real push channel (a
 * MerchantDispatchPort implementation — e.g. real Zalo notification)
 * remains free to independently drive CREATED -> SENT_TO_MERCHANT at
 * send-time without touching this class at all.
 *
 * SECURITY BOUNDARY: every public method's first parameter is the
 * caller's already-authenticated merchant_id (resolved by
 * MerchantAuthService from a verified API key — see
 * platform/api/middleware/merchantAuth.js). This class never trusts a
 * merchant_id from a request body/param — only the one the auth
 * middleware resolved from a real credential.
 *
 * CONCURRENCY: status transitions use a compare-and-swap UPDATE
 * (`WHERE id = ? AND status = ?`), not a blind write — a concurrent
 * writer (e.g. the customer's own cancelOrder) that changes the row
 * between this method's read and write is detected (0 rows affected)
 * and reported as a clean ORDER_STATE_CONFLICT, never silently
 * overwritten. The two transitions are not wrapped in a shared DB
 * transaction: SENT_TO_MERCHANT is itself a valid, meaningful state, so
 * a failure between the two steps leaves a real, resumable state, not
 * corruption — a retried receiveOrder() call continues correctly from
 * wherever it left off (assertTransition treats same-state as a no-op).
 */
export class MerchantOrderError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function requirePositiveInt(value, code, message, status = 404) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new MerchantOrderError(code, message, status);
  }
}

// Deliberate DTO/projection (Phase 7 Data Exposure rule) — never a raw DB
// row. Excludes payment_status/delivery_status/cart_id/customer_id/
// zalo_user_id and any other internal field; customer identity stays
// minimal (display name + phone only, both already nullable/never
// populated with anything sensitive today).
function projectOrder(orderRow, items, customer) {
  return {
    id: orderRow.id,
    order_code: orderRow.order_code,
    merchant_id: orderRow.merchant_id,
    status: orderRow.status,
    subtotal: orderRow.subtotal,
    total: orderRow.total,
    created_at: orderRow.created_at,
    updated_at: orderRow.updated_at,
    customer: {
      display_name: customer?.display_name ?? null,
      phone: customer?.phone ?? null,
    },
    items: items.map((i) => ({
      product_id: i.product_id,
      product_name: i.product_name,
      quantity: i.quantity,
      unit_price: i.unit_price,
      line_total: i.line_total,
    })),
  };
}

export class MerchantOrderService {
  constructor(repos) {
    this.repos = repos;
    this.db = repos.orders.db; // shared platform connection, exposed by the repo — read-only reuse, no change to orderRepository.js
  }

  _ownedOrder(merchantId, orderId) {
    requirePositiveInt(orderId, "ORDER_NOT_FOUND", `Order ${orderId} not found`);
    const order = this.db.prepare(`SELECT * FROM orders WHERE id = ?`).get(orderId);
    if (!order) throw new MerchantOrderError("ORDER_NOT_FOUND", `Order ${orderId} not found`, 404);
    if (order.merchant_id !== merchantId) {
      // Same non-leaking shape MenuService/CartService already use for
      // cross-tenant resources — never a different code for "exists but
      // not yours" vs "doesn't exist", so no existence is ever leaked.
      throw new MerchantOrderError("ORDER_NOT_FOUND", `Order ${orderId} not found`, 404);
    }
    return order;
  }

  _hydrate(order) {
    const items = this.db.prepare(`SELECT * FROM order_items WHERE order_id = ? ORDER BY id`).all(order.id);
    const customer = this.repos.customers.findById(order.customer_id);
    return projectOrder(order, items, customer);
  }

  listOrders(merchantId) {
    if (typeof merchantId !== "string" || merchantId.trim().length === 0) {
      throw new MerchantOrderError("INVALID_CALLER_IDENTITY", "merchantId must be a non-empty string", 401);
    }
    const orders = this.db.prepare(`SELECT * FROM orders WHERE merchant_id = ? ORDER BY id DESC`).all(merchantId);
    return orders.map((o) => this._hydrate(o));
  }

  getOrder(merchantId, orderId) {
    const order = this._ownedOrder(merchantId, orderId);
    return this._hydrate(order);
  }

  receiveOrder(merchantId, orderId) {
    const order = this._ownedOrder(merchantId, orderId);

    if (order.status === ORDER_STATUS.RECEIVED) {
      return this._hydrate(order); // idempotent no-op — already received (duplicate receive)
    }

    if (order.status !== ORDER_STATUS.SENT_TO_MERCHANT) {
      assertTransition(order.status, ORDER_STATUS.SENT_TO_MERCHANT); // throws INVALID_ORDER_TRANSITION for CANCELLED, etc.
      this._guardedSetStatus(orderId, order.status, ORDER_STATUS.SENT_TO_MERCHANT);
    }

    assertTransition(ORDER_STATUS.SENT_TO_MERCHANT, ORDER_STATUS.RECEIVED);
    this._guardedSetStatus(orderId, ORDER_STATUS.SENT_TO_MERCHANT, ORDER_STATUS.RECEIVED);

    return this._hydrate(this.db.prepare(`SELECT * FROM orders WHERE id = ?`).get(orderId));
  }

  // Compare-and-swap UPDATE — see class doc "CONCURRENCY".
  _guardedSetStatus(orderId, expectedCurrentStatus, newStatus) {
    const result = this.db
      .prepare(`UPDATE orders SET status = ?, updated_at = datetime('now') WHERE id = ? AND status = ?`)
      .run(newStatus, orderId, expectedCurrentStatus);
    if (result.changes === 0) {
      throw new MerchantOrderError("ORDER_STATE_CONFLICT", `Order ${orderId} status changed concurrently — retry`, 409);
    }
  }
}
