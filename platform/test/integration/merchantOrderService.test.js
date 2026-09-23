import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTestPlatform } from "../helpers/testPlatform.js";

function twoMerchants() {
  return buildTestPlatform({ withAtieu: false, genericFixtureMerchants: ["MERCHANT002", "MERCHANT003"] });
}

function makeCustomer(platform, suffix = "") {
  return platform.services.customers.getOrCreateByZaloUserId(`merchant-order-test-${Date.now()}-${Math.random()}${suffix}`, "Test Customer");
}

function m2Product(platform) {
  return platform.services.menu.listProducts("MERCHANT002", { includeUnavailable: true })[0];
}

async function createOrder(platform, customer, quantity = 2, merchantId = "MERCHANT002") {
  const cart = platform.services.cart.createCart(customer.id, merchantId);
  const product = platform.services.menu.listProducts(merchantId, { includeUnavailable: true })[0];
  platform.services.cart.addItem(customer.id, cart.id, merchantId, product.id, quantity);
  return platform.services.orders.confirmOrder(customer.id, cart.id);
}

// --- Visibility ----------------------------------------------------------

test("listOrders returns the merchant's own orders, newest first, as a projected DTO", async () => {
  const platform = twoMerchants();
  const customer = makeCustomer(platform);
  const order1 = await createOrder(platform, customer, 1);
  const order2 = await createOrder(platform, customer, 3);

  const list = platform.services.merchantOrders.listOrders("MERCHANT002");
  assert.equal(list.length, 2);
  assert.equal(list[0].id, order2.id); // newest first
  assert.equal(list[1].id, order1.id);
  assert.equal(list[0].merchant_id, "MERCHANT002");
});

test("listOrders never returns another merchant's orders", async () => {
  const platform = twoMerchants();
  const customer = makeCustomer(platform);
  await createOrder(platform, customer, 1, "MERCHANT002");
  await createOrder(platform, customer, 1, "MERCHANT003");

  const list = platform.services.merchantOrders.listOrders("MERCHANT002");
  assert.equal(list.length, 1);
  assert.equal(list[0].merchant_id, "MERCHANT002");
});

test("getOrder returns full order detail: items, quantities, prices, line totals, subtotal, total, status, timestamps", async () => {
  const platform = twoMerchants();
  const customer = makeCustomer(platform);
  const product = m2Product(platform);
  const order = await createOrder(platform, customer, 4);

  const fetched = platform.services.merchantOrders.getOrder("MERCHANT002", order.id);
  assert.equal(fetched.id, order.id);
  assert.equal(fetched.order_code, order.order_code);
  assert.equal(fetched.merchant_id, "MERCHANT002");
  assert.equal(fetched.status, "CREATED");
  assert.ok(fetched.created_at);
  assert.ok(fetched.updated_at);
  assert.equal(fetched.subtotal, product.price * 4);
  assert.equal(fetched.total, product.price * 4);
  assert.equal(fetched.items.length, 1);
  assert.equal(fetched.items[0].product_name, product.name);
  assert.equal(fetched.items[0].quantity, 4);
  assert.equal(fetched.items[0].unit_price, product.price);
  assert.equal(fetched.items[0].line_total, product.price * 4);
});

test("the projected DTO never exposes payment_status, delivery_status, cart_id, customer_id, or zalo_user_id", async () => {
  const platform = twoMerchants();
  const customer = makeCustomer(platform);
  const order = await createOrder(platform, customer, 1);

  const fetched = platform.services.merchantOrders.getOrder("MERCHANT002", order.id);
  for (const forbiddenField of ["payment_status", "delivery_status", "cart_id", "customer_id", "zalo_user_id"]) {
    assert.equal(Object.prototype.hasOwnProperty.call(fetched, forbiddenField), false, `DTO must not include ${forbiddenField}`);
  }
  assert.equal(Object.prototype.hasOwnProperty.call(fetched.customer, "zalo_user_id"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(fetched.customer, "id"), false);
});

// --- Receive ---------------------------------------------------------------

test("receiveOrder transitions CREATED -> SENT_TO_MERCHANT -> RECEIVED in one explicit action", async () => {
  const platform = twoMerchants();
  const customer = makeCustomer(platform);
  const order = await createOrder(platform, customer);
  assert.equal(order.status, "CREATED"); // NullMerchantDispatchPort — never auto-advanced

  const received = platform.services.merchantOrders.receiveOrder("MERCHANT002", order.id);
  assert.equal(received.status, "RECEIVED");
});

test("receiveOrder is idempotent — calling it again on an already-RECEIVED order is a clean no-op", async () => {
  const platform = twoMerchants();
  const customer = makeCustomer(platform);
  const order = await createOrder(platform, customer);
  platform.services.merchantOrders.receiveOrder("MERCHANT002", order.id);

  const second = platform.services.merchantOrders.receiveOrder("MERCHANT002", order.id);
  assert.equal(second.status, "RECEIVED");
});

test("receiveOrder on a CANCELLED order is rejected with INVALID_ORDER_TRANSITION", async () => {
  const platform = twoMerchants();
  const customer = makeCustomer(platform);
  const order = await createOrder(platform, customer);
  platform.services.orders.cancelOrder(customer.id, order.id);

  assert.throws(() => platform.services.merchantOrders.receiveOrder("MERCHANT002", order.id), (err) => {
    assert.equal(err.code, "INVALID_ORDER_TRANSITION");
    return true;
  });
});

test("resumability: if the process is interrupted between the two internal transitions, the order is left at the valid intermediate state SENT_TO_MERCHANT, and a retried receiveOrder correctly completes to RECEIVED", async () => {
  const platform = twoMerchants();
  const customer = makeCustomer(platform);
  const order = await createOrder(platform, customer);

  const svc = platform.services.merchantOrders;
  const originalGuarded = svc._guardedSetStatus.bind(svc);
  let call = 0;
  svc._guardedSetStatus = (orderId, expected, next) => {
    call += 1;
    if (call === 2) throw new Error("simulated interruption after CREATED->SENT_TO_MERCHANT");
    return originalGuarded(orderId, expected, next);
  };

  try {
    assert.throws(() => svc.receiveOrder("MERCHANT002", order.id), /simulated interruption/);
  } finally {
    svc._guardedSetStatus = originalGuarded;
  }

  const mid = platform.services.merchantOrders.getOrder("MERCHANT002", order.id);
  assert.equal(mid.status, "SENT_TO_MERCHANT"); // real, valid, resumable state — not corrupted

  const resumed = platform.services.merchantOrders.receiveOrder("MERCHANT002", order.id);
  assert.equal(resumed.status, "RECEIVED");
});
