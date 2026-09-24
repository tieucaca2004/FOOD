import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTestPlatform } from "../helpers/testPlatform.js";
import { generateOrderCode } from "../../domain/orderCode.js";
import { platformConfig } from "../../config.js";

function setup() {
  const platform = buildTestPlatform({ withAtieu: false, genericFixtureMerchants: ["MERCHANT002"] });
  const product = platform.services.menu.listProducts("MERCHANT002", { includeUnavailable: true })[0];
  const newCart = (label) => {
    const customer = platform.services.customers.getOrCreateByZaloUserId(`collision-${label}-${Math.random()}`, label);
    const cart = platform.services.cart.createCart(customer.id, "MERCHANT002");
    platform.services.cart.addItem(customer.id, cart.id, "MERCHANT002", product.id, 1);
    return { customer, cart };
  };
  return { platform, newCart };
}

// The per-day sequence is COUNT(today's orders) + 1, so an existing order
// already holding the next sequence number (a gap) forces a real collision.
function occupyNextOrderCode(platform, blocker) {
  const code = generateOrderCode(new Date(), 2, platformConfig.orderCodePrefix);
  platform.db
    .prepare(
      `INSERT INTO orders (order_code, merchant_id, customer_id, cart_id, status, subtotal, total) VALUES (?, 'MERCHANT002', ?, ?, 'CANCELLED', 0, 0)`
    )
    .run(code, blocker.customer.id, blocker.cart.id);
  return code;
}

test("BUG-001: an order-code collision is reported as ORDER_CODE_CONFLICT (503), not as a cart conflict", async () => {
  const { platform, newCart } = setup();
  const blocked = occupyNextOrderCode(platform, newCart("blocker"));
  const { customer, cart } = newCart("buyer");

  await assert.rejects(platform.services.orders.confirmOrder(customer.id, cart.id), (err) => {
    assert.equal(err.code, "ORDER_CODE_CONFLICT");
    assert.equal(err.status, 503);
    return true;
  });

  // Nothing was written and the cart is still usable.
  assert.equal(platform.db.prepare("SELECT COUNT(*) AS n FROM orders WHERE cart_id = ?").get(cart.id).n, 0);
  assert.equal(platform.db.prepare("SELECT status FROM merchant_carts WHERE id = ?").get(cart.id).status, "ACTIVE");
  assert.equal(platform.db.prepare("SELECT COUNT(*) AS n FROM orders WHERE order_code = ?").get(blocked).n, 1);
});

test("BUG-001: once the code is free, retrying the same cart creates exactly one order", async () => {
  const { platform, newCart } = setup();
  const blocked = occupyNextOrderCode(platform, newCart("blocker"));
  const { customer, cart } = newCart("buyer");

  await assert.rejects(platform.services.orders.confirmOrder(customer.id, cart.id), { code: "ORDER_CODE_CONFLICT" });
  platform.db.prepare("DELETE FROM orders WHERE order_code = ?").run(blocked);

  const order = await platform.services.orders.confirmOrder(customer.id, cart.id);
  assert.equal(order.cart_id, cart.id);
  await assert.rejects(platform.services.orders.confirmOrder(customer.id, cart.id), { code: "CART_INACTIVE" });
  assert.equal(platform.db.prepare("SELECT COUNT(*) AS n FROM orders WHERE cart_id = ?").get(cart.id).n, 1);
});

test("BUG-001: a genuine cart conflict (an active order already holds the cart) is still ORDER_ALREADY_EXISTS_FOR_CART", async () => {
  const { platform, newCart } = setup();
  const { customer, cart } = newCart("buyer");
  // An existing non-cancelled order on a still-ACTIVE cart: the state a
  // concurrent confirm leaves behind. Its code is outside today's sequence.
  platform.db
    .prepare(
      `INSERT INTO orders (order_code, merchant_id, customer_id, cart_id, status, subtotal, total) VALUES ('TD-EXISTING-1', 'MERCHANT002', ?, ?, 'CREATED', 0, 0)`
    )
    .run(customer.id, cart.id);
  await assert.rejects(platform.services.orders.confirmOrder(customer.id, cart.id), (err) => {
    assert.equal(err.code, "ORDER_ALREADY_EXISTS_FOR_CART");
    assert.equal(err.status, 409);
    return true;
  });
});
