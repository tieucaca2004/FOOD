import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTestPlatform } from "../helpers/testPlatform.js";
import { FakeMerchantDispatchPort } from "../helpers/fakeMerchantDispatchPort.js";

function twoMerchants(opts = {}) {
  return buildTestPlatform({ withAtieu: false, genericFixtureMerchants: ["MERCHANT002", "MERCHANT003"], ...opts });
}

function makeCustomer(platform, suffix = "") {
  return platform.services.customers.getOrCreateByZaloUserId(`order-test-${Date.now()}-${Math.random()}${suffix}`, "Test Customer");
}

function m2Product(platform) {
  return platform.services.menu.listProducts("MERCHANT002", { includeUnavailable: true })[0]; // FIX2-HAISAN, 72000
}
function m3Product(platform) {
  return platform.services.menu.listProducts("MERCHANT003", { includeUnavailable: true })[0]; // FIX3-BO, 68000
}

function cartWithItem(platform, customer, quantity = 2) {
  const cart = platform.services.cart.createCart(customer.id, "MERCHANT002");
  const product = m2Product(platform);
  platform.services.cart.addItem(customer.id, cart.id, "MERCHANT002", product.id, quantity);
  return { cart, product };
}

// --- A. Order creation ------------------------------------------------

test("1. confirmOrder creates an order with a platform-prefixed order_code", async () => {
  const platform = twoMerchants();
  const customer = makeCustomer(platform);
  const { cart } = cartWithItem(platform, customer);

  const order = await platform.services.orders.confirmOrder(customer.id, cart.id);
  assert.match(order.order_code, /^TD-\d{8}-\d{3}$/);
  assert.equal(order.merchant_id, "MERCHANT002");
  assert.equal(order.customer_id, customer.id);
  assert.equal(order.cart_id, cart.id);
});

test("2. with the default (Null) dispatch port, the order stays CREATED — never fabricated as SENT_TO_MERCHANT", async () => {
  const platform = twoMerchants();
  const customer = makeCustomer(platform);
  const { cart } = cartWithItem(platform, customer);

  const order = await platform.services.orders.confirmOrder(customer.id, cart.id);
  assert.equal(order.status, "CREATED");
});

test("3. when the dispatch port reports delivered:true, the order advances to SENT_TO_MERCHANT", async () => {
  const dispatchPort = new FakeMerchantDispatchPort({ result: { delivered: true } });
  const platform = twoMerchants({ dispatchPort });
  const customer = makeCustomer(platform);
  const { cart } = cartWithItem(platform, customer);

  const order = await platform.services.orders.confirmOrder(customer.id, cart.id);
  assert.equal(order.status, "SENT_TO_MERCHANT");
  assert.equal(dispatchPort.calls.length, 1);
});

test("4. confirming clears the cart's items (cart itself stays ACTIVE, per approved decision #6 reuse of clearCart)", async () => {
  const platform = twoMerchants();
  const customer = makeCustomer(platform);
  const { cart } = cartWithItem(platform, customer);

  await platform.services.orders.confirmOrder(customer.id, cart.id);

  const reloaded = platform.services.cart.getCart(customer.id, cart.id);
  assert.equal(reloaded.status, "ACTIVE");
  assert.equal(reloaded.items.length, 0);
});

// --- B. Checkout validation ---------------------------------------------

test("5. confirming an empty cart is rejected with CART_EMPTY", async () => {
  const platform = twoMerchants();
  const customer = makeCustomer(platform);
  const cart = platform.services.cart.createCart(customer.id, "MERCHANT002");

  await assert.rejects(() => platform.services.orders.confirmOrder(customer.id, cart.id), (err) => {
    assert.equal(err.code, "CART_EMPTY");
    return true;
  });
});

test("6. confirming a cart owned by another customer is rejected with CART_NOT_OWNED", async () => {
  const platform = twoMerchants();
  const owner = makeCustomer(platform, "owner");
  const attacker = makeCustomer(platform, "attacker");
  const { cart } = cartWithItem(platform, owner);

  await assert.rejects(() => platform.services.orders.confirmOrder(attacker.id, cart.id), (err) => {
    assert.equal(err.code, "CART_NOT_OWNED");
    return true;
  });
});

test("7. confirming a nonexistent cart is rejected with CART_NOT_FOUND", async () => {
  const platform = twoMerchants();
  const customer = makeCustomer(platform);

  await assert.rejects(() => platform.services.orders.confirmOrder(customer.id, 999999), (err) => {
    assert.equal(err.code, "CART_NOT_FOUND");
    return true;
  });
});

test("8. confirming against a SUSPENDED merchant is rejected with MERCHANT_NOT_ACTIVE", async () => {
  const platform = twoMerchants();
  const customer = makeCustomer(platform);
  const { cart } = cartWithItem(platform, customer);
  platform.repos.merchants.setStatus("MERCHANT002", "SUSPENDED");

  await assert.rejects(() => platform.services.orders.confirmOrder(customer.id, cart.id), (err) => {
    assert.equal(err.code, "MERCHANT_NOT_ACTIVE");
    return true;
  });
});

test("9. a cart item whose product no longer resolves is rejected with PRODUCT_NOT_FOUND, and no order is created (defense-in-depth: FK constraints make a real orphaned reference unreachable through the public API today — deleting a product still referenced by a cart item is itself blocked at the DB level — so this simulates the orphaned-reference case directly to prove the re-validation guard itself is correct)", async () => {
  const platform = twoMerchants();
  const customer = makeCustomer(platform);
  const { cart } = cartWithItem(platform, customer);

  platform.db.pragma("foreign_keys = OFF");
  platform.db.prepare("UPDATE merchant_cart_items SET product_id = 999999 WHERE cart_id = ?").run(cart.id);
  platform.db.pragma("foreign_keys = ON");

  await assert.rejects(() => platform.services.orders.confirmOrder(customer.id, cart.id), (err) => {
    assert.equal(err.code, "PRODUCT_NOT_FOUND");
    return true;
  });
  assert.equal(platform.services.orders.listOrders(customer.id).length, 0);
});

test("10. a product made unavailable after being added to the cart is rejected with PRODUCT_UNAVAILABLE", async () => {
  const platform = twoMerchants();
  const customer = makeCustomer(platform);
  const { cart, product } = cartWithItem(platform, customer);
  platform.services.menu.setProductAvailability("MERCHANT002", product.id, false);

  await assert.rejects(() => platform.services.orders.confirmOrder(customer.id, cart.id), (err) => {
    assert.equal(err.code, "PRODUCT_UNAVAILABLE");
    return true;
  });
});

test("11. a menu archived after items were added to the cart is rejected with PRODUCT_UNAVAILABLE (menu not visible)", async () => {
  const platform = twoMerchants();
  const customer = makeCustomer(platform);
  const { cart } = cartWithItem(platform, customer);
  platform.services.menu.createMenu("MERCHANT002");
  platform.services.menu.archiveMenu("MERCHANT002");

  await assert.rejects(() => platform.services.orders.confirmOrder(customer.id, cart.id), (err) => {
    assert.equal(err.code, "PRODUCT_UNAVAILABLE");
    return true;
  });
});

test("12. a price change since add-to-cart is rejected with PRICE_CHANGED — no order created, cart NOT cleared", async () => {
  const platform = twoMerchants();
  const customer = makeCustomer(platform);
  const { cart, product } = cartWithItem(platform, customer);
  platform.services.menu.updateProduct("MERCHANT002", product.id, { price: product.price + 5000 });

  await assert.rejects(() => platform.services.orders.confirmOrder(customer.id, cart.id), (err) => {
    assert.equal(err.code, "PRICE_CHANGED");
    return true;
  });
  assert.equal(platform.services.orders.listOrders(customer.id).length, 0);
  const stillThere = platform.services.cart.getCart(customer.id, cart.id);
  assert.equal(stillThere.items.length, 1); // cart untouched — no automatic repricing, no clearing on failure
});

// --- C. Snapshot correctness / D. Price calculation ----------------------

test("13. order_items preserve product_name/unit_price/quantity/line_total exactly as confirmed", async () => {
  const platform = twoMerchants();
  const customer = makeCustomer(platform);
  const { cart, product } = cartWithItem(platform, customer, 3);

  const order = await platform.services.orders.confirmOrder(customer.id, cart.id);
  assert.equal(order.items.length, 1);
  assert.equal(order.items[0].product_id, product.id);
  assert.equal(order.items[0].product_name, product.name);
  assert.equal(order.items[0].unit_price, product.price);
  assert.equal(order.items[0].quantity, 3);
  assert.equal(order.items[0].line_total, product.price * 3);
});

test("14. a menu price change AFTER an order was confirmed never touches the already-created order", async () => {
  const platform = twoMerchants();
  const customer = makeCustomer(platform);
  const { cart, product } = cartWithItem(platform, customer, 2);
  const order = await platform.services.orders.confirmOrder(customer.id, cart.id);
  const originalPrice = product.price;

  platform.services.menu.updateProduct("MERCHANT002", product.id, { price: originalPrice + 99999 });

  const reloaded = platform.services.orders.getOrder(customer.id, order.id);
  assert.equal(reloaded.items[0].unit_price, originalPrice);
  assert.equal(reloaded.subtotal, originalPrice * 2);
});

test("15. subtotal/total are the server-computed sum of line totals across multiple items", async () => {
  const platform = twoMerchants();
  const customer = makeCustomer(platform);
  const cart = platform.services.cart.createCart(customer.id, "MERCHANT002");
  const catId = platform.services.menu.listCategories("MERCHANT002")[0].id;
  const second = platform.services.menu.createProduct("MERCHANT002", { sku: "M2-ORDERTEST", name: "Món B", categoryId: catId, price: 20000 });
  const firstProduct = m2Product(platform);
  platform.services.cart.addItem(customer.id, cart.id, "MERCHANT002", firstProduct.id, 2); // 72000*2=144000
  platform.services.cart.addItem(customer.id, cart.id, "MERCHANT002", second.id, 1); // 20000

  const order = await platform.services.orders.confirmOrder(customer.id, cart.id);
  assert.equal(order.subtotal, 144000 + 20000);
  assert.equal(order.total, 144000 + 20000);
});

// --- G/H. Order history / ownership ---------------------------------------

test("16. getOrder returns the order and its items to the owning customer", async () => {
  const platform = twoMerchants();
  const customer = makeCustomer(platform);
  const { cart } = cartWithItem(platform, customer);
  const order = await platform.services.orders.confirmOrder(customer.id, cart.id);

  const fetched = platform.services.orders.getOrder(customer.id, order.id);
  assert.equal(fetched.id, order.id);
  assert.equal(fetched.items.length, 1);
});

test("17. getOrder is rejected for a non-owning customer with ORDER_NOT_OWNED", async () => {
  const platform = twoMerchants();
  const owner = makeCustomer(platform, "owner");
  const other = makeCustomer(platform, "other");
  const { cart } = cartWithItem(platform, owner);
  const order = await platform.services.orders.confirmOrder(owner.id, cart.id);

  assert.throws(() => platform.services.orders.getOrder(other.id, order.id), (err) => {
    assert.equal(err.code, "ORDER_NOT_OWNED");
    return true;
  });
});

test("18. getOrder for a nonexistent order is rejected with ORDER_NOT_FOUND", () => {
  const platform = twoMerchants();
  const customer = makeCustomer(platform);
  assert.throws(() => platform.services.orders.getOrder(customer.id, 999999), (err) => {
    assert.equal(err.code, "ORDER_NOT_FOUND");
    return true;
  });
});

test("19. listOrders returns only the caller's own orders, newest first", async () => {
  const platform = twoMerchants();
  const customer = makeCustomer(platform);
  const other = makeCustomer(platform, "other");

  const { cart: cartA } = cartWithItem(platform, customer);
  const orderA = await platform.services.orders.confirmOrder(customer.id, cartA.id);
  const cartB = platform.services.cart.createCart(customer.id, "MERCHANT003");
  platform.services.cart.addItem(customer.id, cartB.id, "MERCHANT003", m3Product(platform).id, 1);
  const orderB = await platform.services.orders.confirmOrder(customer.id, cartB.id);

  const { cart: otherCart } = cartWithItem(platform, other);
  await platform.services.orders.confirmOrder(other.id, otherCart.id);

  const list = platform.services.orders.listOrders(customer.id);
  assert.equal(list.length, 2);
  assert.deepEqual(list.map((o) => o.id).sort((a, b) => a - b), [orderA.id, orderB.id].sort((a, b) => a - b));
  assert.equal(list[0].id, orderB.id); // newest first
});

// --- I/J. Cancellation and state transitions ------------------------------

test("20. cancelOrder transitions CREATED -> CANCELLED", async () => {
  const platform = twoMerchants();
  const customer = makeCustomer(platform);
  const { cart } = cartWithItem(platform, customer);
  const order = await platform.services.orders.confirmOrder(customer.id, cart.id);

  const cancelled = platform.services.orders.cancelOrder(customer.id, order.id);
  assert.equal(cancelled.status, "CANCELLED");
});

test("21. cancelOrder transitions SENT_TO_MERCHANT -> CANCELLED", async () => {
  const dispatchPort = new FakeMerchantDispatchPort({ result: { delivered: true } });
  const platform = twoMerchants({ dispatchPort });
  const customer = makeCustomer(platform);
  const { cart } = cartWithItem(platform, customer);
  const order = await platform.services.orders.confirmOrder(customer.id, cart.id);
  assert.equal(order.status, "SENT_TO_MERCHANT");

  const cancelled = platform.services.orders.cancelOrder(customer.id, order.id);
  assert.equal(cancelled.status, "CANCELLED");
});

test("22. cancelOrder by a non-owning customer is rejected, order state unchanged", async () => {
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

test("23. cancelOrder is an idempotent no-op when the order is already CANCELLED", async () => {
  const platform = twoMerchants();
  const customer = makeCustomer(platform);
  const { cart } = cartWithItem(platform, customer);
  const order = await platform.services.orders.confirmOrder(customer.id, cart.id);
  platform.services.orders.cancelOrder(customer.id, order.id);

  const second = platform.services.orders.cancelOrder(customer.id, order.id);
  assert.equal(second.status, "CANCELLED");
});

test("24. cancelOrder on a RECEIVED (terminal) order is rejected with INVALID_ORDER_TRANSITION", async () => {
  const platform = twoMerchants();
  const customer = makeCustomer(platform);
  const { cart } = cartWithItem(platform, customer);
  const order = await platform.services.orders.confirmOrder(customer.id, cart.id);
  // RECEIVED has no reachable public code path in Phase 6 (no merchant-side
  // "mark received" exists — approved decision D/§9 open item) — force the
  // DB state directly to test the terminal-state guard itself.
  platform.repos.orders.setStatus(order.id, "RECEIVED");

  assert.throws(() => platform.services.orders.cancelOrder(customer.id, order.id), (err) => {
    assert.equal(err.code, "INVALID_ORDER_TRANSITION");
    return true;
  });
});

test("25. markDispatched with delivered:false leaves the order at its current status (no fake success)", async () => {
  const dispatchPort = new FakeMerchantDispatchPort({ result: { delivered: false, reason: "NO_DISPATCH_CHANNEL" } });
  const platform = twoMerchants({ dispatchPort });
  const customer = makeCustomer(platform);
  const { cart } = cartWithItem(platform, customer);

  const order = await platform.services.orders.confirmOrder(customer.id, cart.id);
  assert.equal(order.status, "CREATED");
});

test("26. markDispatched(delivered:true) is idempotent when the order is already SENT_TO_MERCHANT", async () => {
  const platform = twoMerchants();
  const customer = makeCustomer(platform);
  const { cart } = cartWithItem(platform, customer);
  const order = await platform.services.orders.confirmOrder(customer.id, cart.id);

  const first = await platform.services.orders.markDispatched(order.id, { delivered: true });
  assert.equal(first.status, "SENT_TO_MERCHANT");
  const second = await platform.services.orders.markDispatched(order.id, { delivered: true });
  assert.equal(second.status, "SENT_TO_MERCHANT"); // no error, no change
});

// --- Documented Phase 6 limitation: one cart converts to at most one --
// non-CANCELLED order, ever (approved decision #2's DB-level guard,
// verified here against the frozen Phase 5 Cart Engine's own contract —
// carts are never deleted/retired, so this is a real, known Phase 6
// limitation, not a test oversight; see Phase 6 final report "Risks").

test("27. re-confirming the same cart after a successful order — even with new items added — is rejected with ORDER_ALREADY_EXISTS_FOR_CART (documented limitation)", async () => {
  const platform = twoMerchants();
  const customer = makeCustomer(platform);
  const { cart } = cartWithItem(platform, customer);
  await platform.services.orders.confirmOrder(customer.id, cart.id);

  // Same (customer, merchant) => same ACTIVE cart row (Phase 5 contract) —
  // add a fresh item and try to confirm again.
  platform.services.cart.addItem(customer.id, cart.id, "MERCHANT002", m2Product(platform).id, 1);
  await assert.rejects(() => platform.services.orders.confirmOrder(customer.id, cart.id), (err) => {
    assert.equal(err.code, "ORDER_ALREADY_EXISTS_FOR_CART");
    return true;
  });
});

// --- O. Concurrency / double confirmation ----------------------------------

test("28. two order-creation attempts for the same cart race at the DB level — only one can create a non-CANCELLED order (approved decision #2: the DB is the final concurrency authority)", () => {
  // better-sqlite3 is fully synchronous and OrderService.confirmOrder has
  // no `await` before its DB transaction commits, so two JS-level
  // Promise.allSettled([confirmOrder(), confirmOrder()]) calls cannot
  // actually interleave in a single-threaded Node process — the first
  // call always runs to completion (including clearCart) before the
  // second one is even invoked. The real concurrency case this guards
  // against is two separate processes/connections both writing to the
  // same SQLite file; that's exercised here directly against the
  // repository, which is exactly the DB-level guard approved decision #2
  // specifies — calling it twice with the same cartId proves the partial
  // UNIQUE index (migration 007), not any particular caller's timing.
  const platform = twoMerchants();
  const customer = makeCustomer(platform);
  const { cart, product } = cartWithItem(platform, customer);

  const items = [{ product_id: product.id, product_name: product.name, unit_price: product.price, quantity: 1 }];
  const first = platform.repos.orders.createDraft({ merchantId: "MERCHANT002", customerId: customer.id, cartId: cart.id, items });
  const second = platform.repos.orders.createDraft({ merchantId: "MERCHANT002", customerId: customer.id, cartId: cart.id, items });

  assert.ok(first, "first createDraft should succeed");
  assert.equal(second, null, "second createDraft for the same cart should be rejected by the DB's partial UNIQUE index");

  const rows = platform.db.prepare("SELECT * FROM orders WHERE cart_id = ?").all(cart.id);
  assert.equal(rows.length, 1);
});

test("28b. calling confirmOrder twice back-to-back on the same cart (the literal double-click pattern) never produces two orders or corrupts state", async () => {
  // Documents the actual observed behavior for this exact call pattern:
  // since confirmOrder has no `await` before its DB transaction commits
  // and clearCart runs, the first call always finishes (order created,
  // cart cleared) before the second one starts — so the second call
  // observes CART_EMPTY, not a duplicate order. Either way, the
  // invariant that matters holds: never more than one non-CANCELLED
  // order for this cart.
  const platform = twoMerchants();
  const customer = makeCustomer(platform);
  const { cart } = cartWithItem(platform, customer);

  const results = await Promise.allSettled([
    platform.services.orders.confirmOrder(customer.id, cart.id),
    platform.services.orders.confirmOrder(customer.id, cart.id),
  ]);

  const fulfilled = results.filter((r) => r.status === "fulfilled");
  const rejected = results.filter((r) => r.status === "rejected");
  assert.equal(fulfilled.length, 1, "exactly one confirm succeeds");
  assert.equal(rejected.length, 1, "the other fails cleanly, never a raw error");
  assert.equal(rejected[0].reason.code, "CART_EMPTY");

  const orders = platform.services.orders.listOrders(customer.id);
  assert.equal(orders.length, 1);
});

// --- P. Transaction rollback -------------------------------------------

test("29. a failure between order-header insertion and order_items completion leaves no partial order", async () => {
  const platform = twoMerchants();
  const customer = makeCustomer(platform);
  const cart = platform.services.cart.createCart(customer.id, "MERCHANT002");
  const catId = platform.services.menu.listCategories("MERCHANT002")[0].id;
  const p1 = m2Product(platform);
  const p2 = platform.services.menu.createProduct("MERCHANT002", { sku: "M2-ROLLBACK", name: "Rollback Test", categoryId: catId, price: 15000 });
  platform.services.cart.addItem(customer.id, cart.id, "MERCHANT002", p1.id, 1);
  platform.services.cart.addItem(customer.id, cart.id, "MERCHANT002", p2.id, 1);

  const orderRepo = platform.services.orders.repos.orders;
  const rawDb = orderRepo.db;
  const originalPrepare = rawDb.prepare.bind(rawDb);
  let itemInsertCount = 0;
  rawDb.prepare = (sql) => {
    const stmt = originalPrepare(sql);
    if (sql.includes("INSERT INTO order_items")) {
      const originalRun = stmt.run.bind(stmt);
      stmt.run = (...args) => {
        itemInsertCount += 1;
        if (itemInsertCount === 2) throw new Error("simulated failure before order_items completion");
        return originalRun(...args);
      };
    }
    return stmt;
  };

  try {
    await assert.rejects(() => platform.services.orders.confirmOrder(customer.id, cart.id), /simulated failure/);
  } finally {
    rawDb.prepare = originalPrepare;
  }

  // No partial order: neither the order header nor its first item survive.
  assert.equal(platform.services.orders.listOrders(customer.id).length, 0);
  const rawOrders = rawDb.prepare(`SELECT * FROM orders WHERE customer_id = ?`).all(customer.id);
  assert.equal(rawOrders.length, 0);
  const rawItems = rawDb.prepare(`SELECT * FROM order_items`).all();
  assert.equal(rawItems.length, 0);
  // Cart was never cleared either — clearCart only runs after a successful commit.
  const stillThere = platform.services.cart.getCart(customer.id, cart.id);
  assert.equal(stillThere.items.length, 2);
});
