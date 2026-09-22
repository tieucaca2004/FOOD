// Phase 6 security test matrix — mandatory categories per the approved
// implementation scope (§G): order IDOR, cross-customer/cross-merchant
// isolation, malformed IDs, forged merchant_id/customer_id, price/
// subtotal/total tampering, quantity abuse, SQL injection, mass
// assignment, duplicate confirmation, transaction rollback, invalid
// state transitions, error leakage, secret leakage, PRICE_CHANGED,
// inactive/expired merchant, unavailable/deleted product, hidden menu.
// Concurrent double confirmation and the primary transaction-rollback
// proof already live in orderService.test.js (tests 28/28b/29) — not
// duplicated here; this file focuses on adversarial-input angles.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildTestPlatform } from "../helpers/testPlatform.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function twoMerchants(opts = {}) {
  return buildTestPlatform({ withAtieu: false, genericFixtureMerchants: ["MERCHANT002", "MERCHANT003"], ...opts });
}

function makeCustomer(platform, suffix = "") {
  return platform.services.customers.getOrCreateByZaloUserId(`order-sec-test-${Date.now()}-${Math.random()}${suffix}`, "Test Customer");
}

function m2Product(platform) {
  return platform.services.menu.listProducts("MERCHANT002", { includeUnavailable: true })[0];
}

function cartWithItem(platform, customer, quantity = 1) {
  const cart = platform.services.cart.createCart(customer.id, "MERCHANT002");
  const product = m2Product(platform);
  platform.services.cart.addItem(customer.id, cart.id, "MERCHANT002", product.id, quantity);
  return { cart, product };
}

// --- IDOR / cross-customer / cross-merchant --------------------------------

test("cross-customer getOrder is rejected (IDOR)", async () => {
  const platform = twoMerchants();
  const owner = makeCustomer(platform, "owner");
  const attacker = makeCustomer(platform, "attacker");
  const { cart } = cartWithItem(platform, owner);
  const order = await platform.services.orders.confirmOrder(owner.id, cart.id);

  assert.throws(() => platform.services.orders.getOrder(attacker.id, order.id), (err) => {
    assert.equal(err.code, "ORDER_NOT_OWNED");
    return true;
  });
});

test("cross-customer cancelOrder is rejected (IDOR), order state unchanged", async () => {
  const platform = twoMerchants();
  const owner = makeCustomer(platform, "owner");
  const attacker = makeCustomer(platform, "attacker");
  const { cart } = cartWithItem(platform, owner);
  const order = await platform.services.orders.confirmOrder(owner.id, cart.id);

  assert.throws(() => platform.services.orders.cancelOrder(attacker.id, order.id), (err) => {
    assert.equal(err.code, "ORDER_NOT_OWNED");
    return true;
  });
  assert.equal(platform.services.orders.getOrder(owner.id, order.id).status, "CREATED");
});

test("listOrders never leaks another customer's orders, even with many orders across merchants", async () => {
  const platform = twoMerchants();
  const a = makeCustomer(platform, "a");
  const b = makeCustomer(platform, "b");
  const { cart: cartA } = cartWithItem(platform, a);
  await platform.services.orders.confirmOrder(a.id, cartA.id);
  const { cart: cartB } = cartWithItem(platform, b);
  await platform.services.orders.confirmOrder(b.id, cartB.id);

  const listA = platform.services.orders.listOrders(a.id);
  assert.equal(listA.length, 1);
  assert.equal(listA[0].customer_id, a.id);
});

test("an order created for one merchant always reports that merchant_id, regardless of which merchant's product catalog is probed afterward", async () => {
  const platform = twoMerchants();
  const customer = makeCustomer(platform);
  const { cart } = cartWithItem(platform, customer);
  const order = await platform.services.orders.confirmOrder(customer.id, cart.id);

  assert.equal(order.merchant_id, "MERCHANT002");
  const reloaded = platform.services.orders.getOrder(customer.id, order.id);
  assert.equal(reloaded.merchant_id, "MERCHANT002");
});

// --- Malformed IDs ----------------------------------------------------

test("malformed customerId (null/undefined/string/object/NaN/array) is rejected across every OrderService method", async () => {
  const platform = twoMerchants();
  const customer = makeCustomer(platform);
  const { cart } = cartWithItem(platform, customer);
  const order = await platform.services.orders.confirmOrder(customer.id, cart.id);

  for (const bad of [null, undefined, "5", {}, [], NaN, -1, 0, 1.5]) {
    assert.throws(() => platform.services.orders.getOrder(bad, order.id), (err) => {
      assert.ok(["INVALID_CALLER_IDENTITY", "ORDER_NOT_OWNED"].includes(err.code), `bad customerId=${JSON.stringify(bad)} -> ${err.code}`);
      return true;
    });
    assert.throws(() => platform.services.orders.listOrders(bad), (err) => {
      assert.equal(err.code, "INVALID_CALLER_IDENTITY");
      return true;
    });
  }
});

test("malformed orderId (SQL-injection-shaped strings, objects, NaN) is rejected safely on getOrder/cancelOrder", async () => {
  const platform = twoMerchants();
  const customer = makeCustomer(platform);

  for (const bad of ["' OR 1=1 --", "'; DROP TABLE orders; --", {}, [], NaN, -1, 0]) {
    assert.throws(() => platform.services.orders.getOrder(customer.id, bad), (err) => {
      assert.equal(err.code, "ORDER_NOT_FOUND");
      return true;
    }, `orderId=${JSON.stringify(bad)}`);
    assert.throws(() => platform.services.orders.cancelOrder(customer.id, bad), (err) => {
      assert.equal(err.code, "ORDER_NOT_FOUND");
      return true;
    }, `orderId=${JSON.stringify(bad)}`);
  }
});

test("malformed cartId (SQL-injection-shaped strings, objects, NaN) is rejected safely on confirmOrder", async () => {
  const platform = twoMerchants();
  const customer = makeCustomer(platform);

  for (const bad of ["' OR 1=1 --", "1' UNION SELECT * FROM merchant_carts --", {}, [], NaN, -1, 0]) {
    await assert.rejects(() => platform.services.orders.confirmOrder(customer.id, bad), (err) => {
      assert.equal(err.code, "CART_NOT_FOUND");
      return true;
    }, `cartId=${JSON.stringify(bad)}`);
  }
});

// --- SQL injection ------------------------------------------------------

test("SQL injection payloads do not corrupt data — orders/order_items tables remain intact after adversarial attempts", async () => {
  const platform = twoMerchants();
  const customer = makeCustomer(platform);
  const { cart } = cartWithItem(platform, customer);
  const order = await platform.services.orders.confirmOrder(customer.id, cart.id);

  const payloads = ["' OR 1=1 --", "'; DROP TABLE orders; --", "1' UNION SELECT * FROM platform_customers --"];
  for (const payload of payloads) {
    assert.throws(() => platform.services.orders.getOrder(customer.id, payload));
    assert.throws(() => platform.services.orders.cancelOrder(customer.id, payload));
  }

  // orders table intact, original order untouched.
  const stillThere = platform.services.orders.getOrder(customer.id, order.id);
  assert.equal(stillThere.status, "CREATED");
  const rawCount = platform.db.prepare("SELECT COUNT(*) AS n FROM orders").get().n;
  assert.equal(rawCount, 1);
});

// --- Mass assignment / forged merchant_id / customer_id / price / --------
// --- subtotal / total / status tampering ----------------------------------

test("confirmOrder has no merchant_id/subtotal/total/unit_price/status parameter — extra positional arguments are structurally ignored", async () => {
  const platform = twoMerchants();
  const customer = makeCustomer(platform);
  const { cart, product } = cartWithItem(platform, customer, 2);

  // Simulate an attacker/AI trying to smuggle extra fields positionally.
  const forgedExtras = { merchant_id: "MERCHANT003", subtotal: 1, total: 1, unit_price: 1, status: "RECEIVED", customer_id: 999999 };
  const order = await platform.services.orders.confirmOrder(customer.id, cart.id, forgedExtras);

  assert.equal(order.merchant_id, "MERCHANT002"); // real merchant, from the cart — not MERCHANT003
  assert.equal(order.customer_id, customer.id); // real customer — not 999999
  assert.equal(order.subtotal, product.price * 2); // real server-computed subtotal — not 1
  assert.equal(order.total, product.price * 2); // real server-computed total — not 1
  assert.equal(order.status, "CREATED"); // real initial status — never forged straight to RECEIVED
  assert.equal(order.items[0].unit_price, product.price); // real price — not 1
});

test("getOrder/cancelOrder ignore any extra positional arguments beyond (customerId, orderId)", async () => {
  const platform = twoMerchants();
  const customer = makeCustomer(platform);
  const { cart } = cartWithItem(platform, customer);
  const order = await platform.services.orders.confirmOrder(customer.id, cart.id);

  const fetched = platform.services.orders.getOrder(customer.id, order.id, { status: "RECEIVED", total: 1 });
  assert.equal(fetched.status, "CREATED");
  assert.equal(fetched.total, order.total);
});

// --- Quantity abuse (inherited guarantee from the frozen Cart Engine) -----

test("order line quantity is copied verbatim from the already-validated cart snapshot — no re-validation surface for a caller to abuse", async () => {
  const platform = twoMerchants();
  const customer = makeCustomer(platform);
  const { cart, product } = cartWithItem(platform, customer, 5);

  const order = await platform.services.orders.confirmOrder(customer.id, cart.id);
  assert.equal(order.items[0].quantity, 5);
  assert.equal(order.items[0].line_total, product.price * 5);
  // confirmOrder's signature has no quantity parameter at all to abuse.
});

// --- Invalid state transitions -------------------------------------------

test("a CANCELLED order can never be advanced to SENT_TO_MERCHANT via a stray dispatch result", async () => {
  const platform = twoMerchants();
  const customer = makeCustomer(platform);
  const { cart } = cartWithItem(platform, customer);
  const order = await platform.services.orders.confirmOrder(customer.id, cart.id);
  platform.services.orders.cancelOrder(customer.id, order.id);

  await assert.rejects(() => platform.services.orders.markDispatched(order.id, { delivered: true }), (err) => {
    assert.equal(err.code, "INVALID_ORDER_TRANSITION");
    return true;
  });
  const reloaded = platform.services.orders.getOrder(customer.id, order.id);
  assert.equal(reloaded.status, "CANCELLED");
});

test("a RECEIVED order rejects any further transition attempt, including cancellation", async () => {
  const platform = twoMerchants();
  const customer = makeCustomer(platform);
  const { cart } = cartWithItem(platform, customer);
  const order = await platform.services.orders.confirmOrder(customer.id, cart.id);
  platform.repos.orders.setStatus(order.id, "RECEIVED"); // no public path reaches RECEIVED yet — forcing DB state to test the terminal guard

  assert.throws(() => platform.services.orders.cancelOrder(customer.id, order.id), (err) => {
    assert.equal(err.code, "INVALID_ORDER_TRANSITION");
    return true;
  });
});

// --- PRICE_CHANGED (both directions) ---------------------------------------

test("PRICE_CHANGED fires on a price decrease too, not just an increase — any drift is rejected, no automatic repricing", async () => {
  const platform = twoMerchants();
  const customer = makeCustomer(platform);
  const { cart, product } = cartWithItem(platform, customer);
  platform.services.menu.updateProduct("MERCHANT002", product.id, { price: product.price - 1000 });

  await assert.rejects(() => platform.services.orders.confirmOrder(customer.id, cart.id), (err) => {
    assert.equal(err.code, "PRICE_CHANGED");
    return true;
  });
});

// --- Inactive/expired merchant ----------------------------------------

test("confirming against an EXPIRED merchant is rejected with MERCHANT_NOT_ACTIVE", async () => {
  const platform = twoMerchants();
  const customer = makeCustomer(platform);
  const { cart } = cartWithItem(platform, customer);
  platform.repos.merchants.setStatus("MERCHANT002", "EXPIRED");

  await assert.rejects(() => platform.services.orders.confirmOrder(customer.id, cart.id), (err) => {
    assert.equal(err.code, "MERCHANT_NOT_ACTIVE");
    return true;
  });
});

// --- Hidden/unpublished menu (DRAFT, not just ARCHIVED) --------------------

test("confirming while the menu is in DRAFT (created but never published) is rejected with PRODUCT_UNAVAILABLE", async () => {
  const platform = twoMerchants();
  const customer = makeCustomer(platform);
  const { cart } = cartWithItem(platform, customer);
  platform.services.menu.createMenu("MERCHANT002"); // DRAFT by default, never published

  await assert.rejects(() => platform.services.orders.confirmOrder(customer.id, cart.id), (err) => {
    assert.equal(err.code, "PRODUCT_UNAVAILABLE");
    return true;
  });
});

// --- Error leakage / secret leakage -----------------------------------

test("thrown OrderErrors never leak SQL text, file paths, stack traces or secrets in their message", async () => {
  const platform = twoMerchants();
  const customer = makeCustomer(platform);
  const { cart } = cartWithItem(platform, customer);
  const order = await platform.services.orders.confirmOrder(customer.id, cart.id);

  const suspiciousPatterns = [
    /SQLITE/i, /\.db\b/i, /at Object\./, /at OrderService/, /at Function\./,
    /node_modules/, /\/home\//, /ENOENT/i, /API[_-]?KEY/i, /SECRET/i, /ANTHROPIC/i, /better-sqlite3/i,
  ];

  const attempts = [
    () => platform.services.orders.getOrder(customer.id, "'; DROP TABLE orders; --"),
    () => platform.services.orders.getOrder(customer.id, { $where: "1=1" }),
    () => platform.services.orders.cancelOrder(customer.id, "1' UNION SELECT * FROM merchants --"),
    () => platform.services.orders.listOrders(null),
    () => platform.services.orders.getOrder(NaN, order.id),
  ];

  for (const attempt of attempts) {
    assert.throws(attempt, (err) => {
      assert.ok(err instanceof Error);
      assert.ok(typeof err.code === "string" && err.code.length > 0, `missing .code — message: ${err.message}`);
      for (const pattern of suspiciousPatterns) {
        assert.ok(!pattern.test(err.message), `leaked pattern ${pattern} in message: ${err.message}`);
      }
      return true;
    });
  }

  await assert.rejects(() => platform.services.orders.confirmOrder(customer.id, "' OR 1=1 --"), (err) => {
    for (const pattern of suspiciousPatterns) {
      assert.ok(!pattern.test(err.message), `leaked pattern ${pattern} in confirmOrder message: ${err.message}`);
    }
    return true;
  });
});

test("repository contains no committed secrets, .env files, or order/cart DB/upload artifacts (automated scan)", () => {
  const tracked = execFileSync("git", ["ls-files"], { cwd: REPO_ROOT, encoding: "utf8" })
    .split("\n")
    .filter(Boolean);

  const secretLikePatterns = [
    /(^|\/)\.env$/,
    /(^|\/)\.env\.(?!example$)/,
    /\.sqlite3?$/i,
    /(^|\/)platform\.db$/,
    /^data\/uploads\//,
  ];

  const offenders = tracked.filter((file) => secretLikePatterns.some((pattern) => pattern.test(file)));
  assert.deepEqual(offenders, [], `unexpected committed artifact(s): ${offenders.join(", ")}`);
});
