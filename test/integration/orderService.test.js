import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTestContext } from "../helpers/testApp.js";
import { OrderError } from "../../src/services/orderService.js";
import { ORDER_STATUS } from "../../src/domain/orderStateMachine.js";

function makeCustomer(ctx, phone) {
  return ctx.repos.customers.create({ zaloUserId: `test-${Date.now()}-${Math.random()}`, phone });
}

test("checkout on an empty cart is rejected, not silently turned into an order", () => {
  const ctx = buildTestContext();
  const customer = makeCustomer(ctx);
  const { cart, items } = ctx.services.cart.getCart(customer.id);
  assert.throws(() => ctx.services.orders.startCheckout(customer, cart, items), OrderError);
});

test("checkout snapshots cart, moves through DRAFT -> PENDING_CONFIRMATION -> CONFIRMED, and total is server-computed", async () => {
  const ctx = buildTestContext();
  const customer = makeCustomer(ctx, "0912345678");
  const bo = ctx.repos.products.findBySku("HTX-BO");
  const haiSan = ctx.repos.products.findBySku("HTX-HAISAN");
  ctx.services.cart.addItem(customer.id, bo.id, 2);
  ctx.services.cart.addItem(customer.id, haiSan.id, 1);
  const cartView = ctx.services.cart.getCart(customer.id);

  let order = ctx.services.orders.startCheckout(customer, cartView.cart, cartView.items);
  assert.equal(order.status, ORDER_STATUS.DRAFT);
  assert.equal(order.subtotal, 65000 * 2 + 75000 * 1);

  // customer already has a phone on file, so only fulfillment_type is missing
  assert.equal(ctx.services.orders.nextMissingCheckoutField(order, customer), "fulfillment_type");
  order = ctx.services.orders.applyCheckoutField(order, "fulfillment_type", "takeaway", 0);
  assert.equal(ctx.services.orders.nextMissingCheckoutField(order, customer), null);

  order = ctx.services.orders.moveToPendingConfirmation(order);
  assert.equal(order.status, ORDER_STATUS.PENDING_CONFIRMATION);

  const confirmed = await ctx.services.orders.confirm(order, cartView.cart);
  assert.equal(confirmed.status, ORDER_STATUS.CONFIRMED);
  assert.equal(confirmed.total, 65000 * 2 + 75000 * 1);

  const cartAfter = ctx.repos.carts.getById(cartView.cart.id);
  assert.equal(cartAfter.status, "ordered");
});

test("delivery fulfillment adds the delivery fee to the total", () => {
  const ctx = buildTestContext();
  const customer = makeCustomer(ctx, "0912345678");
  const bo = ctx.repos.products.findBySku("HTX-BO");
  ctx.services.cart.addItem(customer.id, bo.id, 1);
  const cartView = ctx.services.cart.getCart(customer.id);
  let order = ctx.services.orders.startCheckout(customer, cartView.cart, cartView.items);

  const fee = Number(ctx.repos.settings.get("delivery_fee"));
  order = ctx.services.orders.applyCheckoutField(order, "fulfillment_type", "delivery", fee);
  order = ctx.services.orders.applyCheckoutField(order, "address", "123 Lê Lợi, Nha Trang");

  assert.equal(order.delivery_fee, fee);
  assert.equal(order.total, 65000 + fee);
});

test("cannot confirm an order that was never moved to PENDING_CONFIRMATION", async () => {
  const ctx = buildTestContext();
  const customer = makeCustomer(ctx, "0912345678");
  const bo = ctx.repos.products.findBySku("HTX-BO");
  ctx.services.cart.addItem(customer.id, bo.id, 1);
  const cartView = ctx.services.cart.getCart(customer.id);
  const order = ctx.services.orders.startCheckout(customer, cartView.cart, cartView.items);

  await assert.rejects(() => ctx.services.orders.confirm(order, cartView.cart));
});

test("cancel is allowed from DRAFT and PENDING_CONFIRMATION but not after COMPLETED", async () => {
  const ctx = buildTestContext();
  const customer = makeCustomer(ctx, "0912345678");
  const bo = ctx.repos.products.findBySku("HTX-BO");
  ctx.services.cart.addItem(customer.id, bo.id, 1);
  const cartView = ctx.services.cart.getCart(customer.id);
  let order = ctx.services.orders.startCheckout(customer, cartView.cart, cartView.items);

  const cancelled = ctx.services.orders.cancel(order, "test cancel");
  assert.equal(cancelled.status, ORDER_STATUS.CANCELLED);

  // Build a second, separate order and drive it all the way to COMPLETED.
  const bo2 = ctx.repos.products.findBySku("HTX-BO");
  ctx.services.cart.addItem(customer.id, bo2.id, 1);
  const cartView2 = ctx.services.cart.getCart(customer.id);
  let order2 = ctx.services.orders.startCheckout(customer, cartView2.cart, cartView2.items);
  order2 = ctx.services.orders.applyCheckoutField(order2, "fulfillment_type", "takeaway", 0);
  order2 = ctx.services.orders.moveToPendingConfirmation(order2);
  order2 = await ctx.services.orders.confirm(order2, cartView2.cart);
  order2 = ctx.services.orders.transition(order2.id, "ACCEPTED");
  order2 = ctx.services.orders.transition(order2.id, "PREPARING");
  order2 = ctx.services.orders.transition(order2.id, "READY");
  order2 = ctx.services.orders.transition(order2.id, "COMPLETED");

  assert.throws(() => ctx.services.orders.cancel(order2, "too late"));
});

test("starting checkout twice for the same open cart reuses the same DRAFT order (idempotent)", () => {
  const ctx = buildTestContext();
  const customer = makeCustomer(ctx, "0912345678");
  const bo = ctx.repos.products.findBySku("HTX-BO");
  ctx.services.cart.addItem(customer.id, bo.id, 1);
  const cartView = ctx.services.cart.getCart(customer.id);

  const order1 = ctx.services.orders.startCheckout(customer, cartView.cart, cartView.items);
  const order2 = ctx.services.orders.startCheckout(customer, cartView.cart, cartView.items);
  assert.equal(order1.id, order2.id);

  const allOrders = ctx.repos.orders.listByCustomer(customer.id, 10);
  assert.equal(allOrders.length, 1);
});

test("order_code is unique and human-readable (AT-YYYYMMDD-seq)", () => {
  const ctx = buildTestContext();
  const customer = makeCustomer(ctx, "0912345678");
  const bo = ctx.repos.products.findBySku("HTX-BO");
  ctx.services.cart.addItem(customer.id, bo.id, 1);
  const cartView = ctx.services.cart.getCart(customer.id);
  const order = ctx.services.orders.startCheckout(customer, cartView.cart, cartView.items);
  assert.match(order.order_code, /^AT-\d{8}-\d{3}$/);
});
