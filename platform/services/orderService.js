import { ORDER_STATUS, assertTransition } from "../domain/orderStateMachine.js";
import { isAccountDiscoverable } from "../domain/merchantStatus.js";

/**
 * Generic Order + Dispatch Engine (Phase 6): the sole business authority
 * for turning a confirmed Cart (Phase 5, frozen) into an order record and
 * handing it to the merchant.
 *
 * BUSINESS MODEL (Phase 6 Master Spec §2 — authoritative, not re-derived
 * here): the platform is a lead/order-relay layer, never the seller of
 * record. An Order here means "a request the customer confirmed and the
 * platform is handing to the merchant" — not a financial transaction the
 * platform owns. There is deliberately no payment step, no delivery
 * step, no settlement step, no commission. PaymentService/DeliveryService
 * exist elsewhere in the codebase as unused/future scaffolding — this
 * class never calls them (approved decision J).
 *
 * SECURITY BOUNDARY (mirrors CartService's own, same identity contract):
 * every public method's first parameter is the caller's already-
 * authenticated identity (platform_customers.id). This class never
 * authenticates — it only verifies the given identity actually owns the
 * order/cart being touched.
 *
 * SERVER AUTHORITY (approved decision F): confirmOrder(customerId,
 * cartId) has no merchant_id/subtotal/total/unit_price/status parameter
 * at all — merchant_id is resolved from the cart's own (already
 * server-authoritative) merchant_id, and every price figure is computed
 * from MenuService's live product records, never accepted from a caller.
 *
 * DISPATCH (approved decision #1): no real merchant push channel exists
 * today (see merchantDispatch.js). An order created through this service
 * stays at CREATED unless dispatchPort.dispatch() actually reports
 * delivered:true — never advanced to SENT_TO_MERCHANT just because it
 * was written to the DB.
 *
 * IDEMPOTENCY / CONCURRENCY (approved decision #2): enforced entirely by
 * a DB-level partial UNIQUE index (orders(cart_id) WHERE status !=
 * 'CANCELLED', migration 007) — no idempotency-key table. The DB is the
 * final concurrency authority: two concurrent confirmOrder calls on the
 * same cart race to PlatformOrderRepository.createDraft's INSERT, and
 * only one can win; the loser gets a clean ORDER_ALREADY_EXISTS_FOR_CART.
 *
 * CART LIFECYCLE (Phase 6.x): confirming a cart RETIRES it — atomically,
 * in the same DB transaction as the order it becomes (see
 * PlatformOrderRepository.createDraft and platform/domain/
 * cartLifecycle.js). A retired (CONVERTED) cart can never be reused or
 * reopened — CartService's own frozen ownership guard already rejects
 * any further read/mutation on it (CART_INACTIVE) — the customer gets a
 * brand-new ACTIVE cart for their next order with the same merchant
 * (CartService.createCart already does this correctly, unmodified: a
 * CONVERTED cart is invisible to its `WHERE status = 'ACTIVE'` lookup).
 * So UNIQUE(cart_id) means exactly "one cart converts to at most one
 * order" — not "one order ever per customer+merchant".
 *
 * POST-COMMIT FAILURE (approved decision #3, narrowed by Phase 6.x): the
 * only step left after the order transaction commits is dispatch — cart
 * retirement is no longer a separate post-commit step (it is now inside
 * the same transaction as order creation), so the previously-documented
 * "cart might not get cleared after a committed order" gap no longer
 * exists. If dispatch fails, the order is never rolled back for it —
 * that failure surfaces as a clean result, and the DB uniqueness guard
 * above still prevents a duplicate order from any retry.
 */
export class OrderError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function requirePositiveInt(value, code, message) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new OrderError(code, message, code === "INVALID_CALLER_IDENTITY" ? 401 : 404);
  }
}

function hydrateOrder(order, items) {
  return { ...order, items };
}

export class OrderService {
  constructor(repos, cartService, menuService, merchantDataService, dispatchPort) {
    this.repos = repos;
    this.cartService = cartService;
    this.menuService = menuService;
    this.merchantDataService = merchantDataService;
    this.dispatchPort = dispatchPort;
  }

  _ownedOrder(customerId, orderId) {
    requirePositiveInt(customerId, "INVALID_CALLER_IDENTITY", "customerId must be a positive integer");
    requirePositiveInt(orderId, "ORDER_NOT_FOUND", `Order ${orderId} not found`);

    const order = this.repos.orders.getById(orderId);
    if (!order) throw new OrderError("ORDER_NOT_FOUND", `Order ${orderId} not found`, 404);
    if (order.customer_id !== customerId) {
      throw new OrderError("ORDER_NOT_OWNED", `Order ${orderId} does not belong to this customer`, 403);
    }
    return order;
  }

  // Confirms a cart into an order. Every validation step re-reads the
  // authoritative source (CartService/MenuService/MerchantDataService) —
  // nothing is trusted from a caller-supplied field, because there is no
  // such field: this method's only inputs are customerId + cartId.
  async confirmOrder(customerId, cartId) {
    // Cart existence/ownership/active-status — reuses frozen CartService
    // exactly as-is (CART_NOT_FOUND / CART_NOT_OWNED / CART_INACTIVE).
    const cart = this.cartService.getCart(customerId, cartId);
    if (cart.isEmpty) {
      throw new OrderError("CART_EMPTY", `Cart ${cartId} is empty`, 400);
    }

    // Merchant is resolved from the cart's own merchant_id — there is no
    // caller-supplied merchant_id to cross-check, so "merchant is still
    // routable" and "merchant ownership" collapse into this one check.
    const merchant = this.merchantDataService.getById(cart.merchant_id);
    if (!merchant || !isAccountDiscoverable({ accountStatus: merchant.account_status, active: merchant.active })) {
      throw new OrderError("MERCHANT_NOT_ACTIVE", `Merchant ${cart.merchant_id} is not active`, 403);
    }

    if (!this.menuService.isMenuVisible(cart.merchant_id)) {
      throw new OrderError("PRODUCT_UNAVAILABLE", `Merchant ${cart.merchant_id}'s menu is not currently published`, 409);
    }

    // Re-validate every item against the live product record — the cart
    // snapshot may be stale (product deleted/hidden/repriced since it was
    // added). PRICE_CHANGED fails the whole confirmation; no automatic
    // repricing (approved decision #5).
    const snapshotItems = [];
    for (const item of cart.items) {
      const product = this.menuService.getProduct(cart.merchant_id, item.product_id); // throws PRODUCT_NOT_FOUND if deleted/cross-tenant
      if (!product.available) {
        throw new OrderError("PRODUCT_UNAVAILABLE", `Product ${item.product_id} is currently unavailable`, 409);
      }
      if (product.price !== item.unit_price) {
        throw new OrderError("PRICE_CHANGED", `Price for product ${item.product_id} has changed since it was added to the cart`, 409);
      }
      snapshotItems.push({
        product_id: item.product_id,
        product_name: item.product_name,
        unit_price: item.unit_price,
        quantity: item.quantity,
      });
    }

    // Order creation AND cart retirement happen atomically inside this
    // one call (Phase 6.x — see PlatformOrderRepository.createDraft): a
    // rollback here leaves no order and the cart still ACTIVE; a commit
    // leaves the order created and the cart already CONVERTED. There is
    // no separate clearCart step and no window where the order exists
    // but the cart is still usable.
    const order = this.repos.orders.createDraft({
      merchantId: cart.merchant_id,
      customerId,
      cartId,
      items: snapshotItems,
    });
    if (!order) {
      throw new OrderError("ORDER_ALREADY_EXISTS_FOR_CART", `An order already exists for cart ${cartId}`, 409);
    }

    // The only step left after the order transaction commits — its
    // failure can never roll back the already-valid, already-committed
    // order (approved decision #3).
    const dispatchResult = await this.dispatchPort.dispatch(order);
    const finalOrder = await this.markDispatched(order.id, dispatchResult);

    return hydrateOrder(finalOrder, this.repos.orders.listItems(order.id));
  }

  getOrder(customerId, orderId) {
    const order = this._ownedOrder(customerId, orderId);
    return hydrateOrder(order, this.repos.orders.listItems(orderId));
  }

  listOrders(customerId) {
    requirePositiveInt(customerId, "INVALID_CALLER_IDENTITY", "customerId must be a positive integer");
    return this.repos.orders.listByCustomer(customerId);
  }

  cancelOrder(customerId, orderId) {
    const order = this._ownedOrder(customerId, orderId);
    assertTransition(order.status, ORDER_STATUS.CANCELLED);
    const updated = this.repos.orders.setStatus(orderId, ORDER_STATUS.CANCELLED);
    return hydrateOrder(updated, this.repos.orders.listItems(orderId));
  }

  // Not customer-facing — called by confirmOrder right after invoking the
  // dispatch port (and may be called again later by a future real
  // dispatch retry mechanism). Only ever advances the order when the
  // dispatch result actually reports success; a Null/failed dispatch
  // leaves the order exactly where it was (no fake success, approved
  // decision D).
  async markDispatched(orderId, dispatchResult) {
    requirePositiveInt(orderId, "ORDER_NOT_FOUND", `Order ${orderId} not found`);
    const order = this.repos.orders.getById(orderId);
    if (!order) throw new OrderError("ORDER_NOT_FOUND", `Order ${orderId} not found`, 404);

    if (!dispatchResult?.delivered) {
      return order;
    }

    assertTransition(order.status, ORDER_STATUS.SENT_TO_MERCHANT);
    return this.repos.orders.setStatus(orderId, ORDER_STATUS.SENT_TO_MERCHANT);
  }
}
