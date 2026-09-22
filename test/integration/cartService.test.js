import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTestContext } from "../helpers/testApp.js";
import { CartError } from "../../src/services/cartService.js";

function makeCustomer(ctx) {
  return ctx.repos.customers.create({ zaloUserId: `test-${Date.now()}-${Math.random()}` });
}

test("add multiple products accumulates lines and computes total in code", () => {
  const ctx = buildTestContext();
  const customer = makeCustomer(ctx);
  const bo = ctx.repos.products.findBySku("HTX-BO");
  const haiSan = ctx.repos.products.findBySku("HTX-HAISAN");

  ctx.services.cart.addItem(customer.id, bo.id, 2);
  const { items, total } = ctx.services.cart.addItem(customer.id, haiSan.id, 1);

  assert.equal(items.length, 2);
  assert.equal(total, 65000 * 2 + 75000 * 1);
});

test("adding the same product twice increments quantity rather than duplicating the line", () => {
  const ctx = buildTestContext();
  const customer = makeCustomer(ctx);
  const bo = ctx.repos.products.findBySku("HTX-BO");

  ctx.services.cart.addItem(customer.id, bo.id, 2);
  const { items, total } = ctx.services.cart.addItem(customer.id, bo.id, 1);

  assert.equal(items.length, 1);
  assert.equal(items[0].quantity, 3);
  assert.equal(total, 65000 * 3);
});

test("update quantity changes the line total", () => {
  const ctx = buildTestContext();
  const customer = makeCustomer(ctx);
  const bo = ctx.repos.products.findBySku("HTX-BO");
  const { items: added } = ctx.services.cart.addItem(customer.id, bo.id, 2);

  const { items, total } = ctx.services.cart.updateItemQuantity(customer.id, added[0].id, 5);
  assert.equal(items[0].quantity, 5);
  assert.equal(total, 65000 * 5);
});

test("remove product empties the matching line", () => {
  const ctx = buildTestContext();
  const customer = makeCustomer(ctx);
  const bo = ctx.repos.products.findBySku("HTX-BO");
  ctx.services.cart.addItem(customer.id, bo.id, 2);

  const { items, total } = ctx.services.cart.removeItemByProduct(customer.id, bo.id);
  assert.equal(items.length, 0);
  assert.equal(total, 0);
});

test("clear cart empties everything", () => {
  const ctx = buildTestContext();
  const customer = makeCustomer(ctx);
  const bo = ctx.repos.products.findBySku("HTX-BO");
  const haiSan = ctx.repos.products.findBySku("HTX-HAISAN");
  ctx.services.cart.addItem(customer.id, bo.id, 1);
  ctx.services.cart.addItem(customer.id, haiSan.id, 1);

  const { items } = ctx.services.cart.clear(customer.id);
  assert.equal(items.length, 0);
});

test("rejects invalid quantities (zero, negative, absurdly large)", () => {
  const ctx = buildTestContext();
  const customer = makeCustomer(ctx);
  const bo = ctx.repos.products.findBySku("HTX-BO");

  assert.throws(() => ctx.services.cart.addItem(customer.id, bo.id, 0), CartError);
  assert.throws(() => ctx.services.cart.addItem(customer.id, bo.id, -5), CartError);
  assert.throws(() => ctx.services.cart.addItem(customer.id, bo.id, 999999), CartError);
});

test("rejects a fake/nonexistent product id", () => {
  const ctx = buildTestContext();
  const customer = makeCustomer(ctx);
  assert.throws(() => ctx.services.cart.addItem(customer.id, 999999, 1), CartError);
});

test("rejects adding an unavailable product", () => {
  const ctx = buildTestContext();
  const customer = makeCustomer(ctx);
  const bo = ctx.repos.products.findBySku("HTX-BO");
  ctx.db.prepare(`UPDATE products SET available = 0 WHERE id = ?`).run(bo.id);

  assert.throws(() => ctx.services.cart.addItem(customer.id, bo.id, 1), (err) => {
    assert.equal(err.code, "PRODUCT_UNAVAILABLE");
    return true;
  });
});
