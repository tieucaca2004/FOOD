// Phase 7 security test matrix (A-R, per spec): authentication,
// authorization, merchant tenant isolation, order IDOR, forged
// merchant_id, forged order_id, customer/merchant boundary, malformed
// input, SQL injection, mass assignment, status transition abuse,
// cross-merchant enumeration, error leakage, secret leakage,
// subscription/inactive merchant access, concurrent receive, duplicate
// receive, rollback integrity. Duplicate receive + resumability
// (rollback integrity) already proven in merchantOrderService.test.js —
// not repeated here; this file focuses on the adversarial-input and
// authorization angles.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildTestPlatform } from "../helpers/testPlatform.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function twoMerchants() {
  return buildTestPlatform({ withAtieu: false, genericFixtureMerchants: ["MERCHANT002", "MERCHANT003"] });
}

function makeCustomer(platform, suffix = "") {
  return platform.services.customers.getOrCreateByZaloUserId(`merchant-order-sec-${Date.now()}-${Math.random()}${suffix}`, "Test Customer");
}

async function createOrder(platform, customer, merchantId = "MERCHANT002", quantity = 1) {
  const cart = platform.services.cart.createCart(customer.id, merchantId);
  const product = platform.services.menu.listProducts(merchantId, { includeUnavailable: true })[0];
  platform.services.cart.addItem(customer.id, cart.id, merchantId, product.id, quantity);
  return platform.services.orders.confirmOrder(customer.id, cart.id);
}

// --- A/B/C/D/G. authentication, authorization, tenant isolation, IDOR,
// customer/merchant boundary ------------------------------------------

test("merchant A cannot list merchant B's orders", async () => {
  const platform = twoMerchants();
  const customer = makeCustomer(platform);
  await createOrder(platform, customer, "MERCHANT003");

  const listAsA = platform.services.merchantOrders.listOrders("MERCHANT002");
  assert.equal(listAsA.length, 0);
});

test("merchant A cannot read merchant B's order by id (IDOR)", async () => {
  const platform = twoMerchants();
  const customer = makeCustomer(platform);
  const orderB = await createOrder(platform, customer, "MERCHANT003");

  assert.throws(() => platform.services.merchantOrders.getOrder("MERCHANT002", orderB.id), (err) => {
    assert.equal(err.code, "ORDER_NOT_FOUND"); // never a different code that would leak "exists but not yours"
    return true;
  });
});

test("merchant A cannot acknowledge (receive) merchant B's order", async () => {
  const platform = twoMerchants();
  const customer = makeCustomer(platform);
  const orderB = await createOrder(platform, customer, "MERCHANT003");

  assert.throws(() => platform.services.merchantOrders.receiveOrder("MERCHANT002", orderB.id), (err) => {
    assert.equal(err.code, "ORDER_NOT_FOUND");
    return true;
  });
  // Merchant B's order is untouched by the attempt.
  const stillCreated = platform.services.merchantOrders.getOrder("MERCHANT003", orderB.id);
  assert.equal(stillCreated.status, "CREATED");
});

test("customer-side order access remains isolated from the merchant-side boundary — a customer's own getOrder never accepts a merchant identity as authority", async () => {
  const platform = twoMerchants();
  const customer = makeCustomer(platform);
  const order = await createOrder(platform, customer);

  // The customer-side OrderService (Phase 6, frozen, untouched) still
  // requires the CUSTOMER's own id — a merchant_id is meaningless to it.
  assert.throws(() => platform.services.orders.getOrder(999999, order.id), (err) => {
    assert.equal(err.code, "ORDER_NOT_OWNED");
    return true;
  });
  // And the merchant-side boundary never accepts a customer_id as a merchant_id.
  assert.throws(() => platform.services.merchantOrders.getOrder(String(customer.id), order.id), (err) => {
    assert.equal(err.code, "ORDER_NOT_FOUND");
    return true;
  });
});

// --- A. authentication (HTTP layer) — unauthenticated access fails -----

test("authentication: verifyApiKey rejects any credential not issued for a real merchant", () => {
  const platform = twoMerchants();
  assert.throws(() => platform.services.merchantAuth.verifyApiKey("mk_never_issued"), (err) => {
    assert.equal(err.code, "UNAUTHENTICATED");
    assert.equal(err.status, 401);
    return true;
  });
});

// --- E/F. forged merchant_id / forged order_id --------------------------

test("forged merchant_id is impossible to supply — listOrders/getOrder/receiveOrder take merchantId only as their own first parameter, never read from an order/body field", async () => {
  const platform = twoMerchants();
  const customer = makeCustomer(platform);
  const order = await createOrder(platform, customer, "MERCHANT002");

  // Extra positional arguments (simulating a forged body field) are
  // structurally ignored — none of these methods have a second
  // "claimed merchant_id" parameter to smuggle one through.
  const list = platform.services.merchantOrders.listOrders("MERCHANT002", { merchant_id: "MERCHANT003" });
  assert.equal(list.length, 1);
  assert.equal(list[0].merchant_id, "MERCHANT002");
});

test("forged order_id (SQL-injection-shaped, negative, float, object, NaN) is rejected safely on getOrder/receiveOrder", async () => {
  const platform = twoMerchants();
  for (const bad of ["' OR 1=1 --", "1' UNION SELECT * FROM orders --", -1, 0, 1.5, NaN, {}, []]) {
    assert.throws(() => platform.services.merchantOrders.getOrder("MERCHANT002", bad), (err) => {
      assert.equal(err.code, "ORDER_NOT_FOUND");
      return true;
    }, `orderId=${JSON.stringify(bad)}`);
    assert.throws(() => platform.services.merchantOrders.receiveOrder("MERCHANT002", bad), (err) => {
      assert.equal(err.code, "ORDER_NOT_FOUND");
      return true;
    }, `orderId=${JSON.stringify(bad)}`);
  }
});

// --- H. malformed input --------------------------------------------------

test("malformed merchantId (null/undefined/empty/object/number) on listOrders is rejected cleanly", () => {
  const platform = twoMerchants();
  for (const bad of [null, undefined, "", {}, [], 12345]) {
    assert.throws(() => platform.services.merchantOrders.listOrders(bad), (err) => {
      assert.equal(err.code, "INVALID_CALLER_IDENTITY");
      return true;
    }, `merchantId=${JSON.stringify(bad)}`);
  }
});

// --- I. SQL injection ------------------------------------------------------

test("SQL injection payloads never corrupt the orders table", async () => {
  const platform = twoMerchants();
  const customer = makeCustomer(platform);
  const order = await createOrder(platform, customer);

  // These are syntactically valid non-empty strings, so listOrders binds
  // them as an ordinary (parameterized) merchant_id value rather than
  // rejecting them outright — the correct, safe outcome is an EMPTY
  // result (no merchant has that literal id), never an error, and never
  // any row from a different merchant.
  const payloads = ["' OR 1=1 --", "'; DROP TABLE orders; --", "MERCHANT002' OR '1'='1"];
  for (const payload of payloads) {
    const result = platform.services.merchantOrders.listOrders(payload);
    assert.deepEqual(result, [], `payload=${payload}`);
  }
  const stillThere = platform.services.merchantOrders.getOrder("MERCHANT002", order.id);
  assert.equal(stillThere.status, "CREATED");
  const rawCount = platform.db.prepare("SELECT COUNT(*) AS n FROM orders").get().n;
  assert.equal(rawCount, 1);
});

// --- J. mass assignment ---------------------------------------------------

test("mass assignment: receiveOrder cannot be tricked into writing any status other than the state machine's own next value", async () => {
  const platform = twoMerchants();
  const customer = makeCustomer(platform);
  const order = await createOrder(platform, customer);

  // receiveOrder(merchantId, orderId) has no status parameter at all.
  const received = platform.services.merchantOrders.receiveOrder("MERCHANT002", order.id, { status: "PAID" });
  assert.equal(received.status, "RECEIVED"); // real, state-machine-driven value — not "PAID"
});

// --- K/L. status transition abuse / cross-merchant enumeration ---------

test("status transition abuse: RECEIVED cannot be forced back to CREATED, SENT_TO_MERCHANT, or CANCELLED via receiveOrder", async () => {
  const platform = twoMerchants();
  const customer = makeCustomer(platform);
  const order = await createOrder(platform, customer);
  platform.services.merchantOrders.receiveOrder("MERCHANT002", order.id);

  // receiveOrder is the only merchant-side mutation — calling it again
  // is the idempotent no-op already tested; there is no other method
  // that could move RECEIVED anywhere else.
  const still = platform.services.merchantOrders.receiveOrder("MERCHANT002", order.id);
  assert.equal(still.status, "RECEIVED");

  const raw = platform.db.prepare("SELECT status FROM orders WHERE id = ?").get(order.id);
  assert.equal(raw.status, "RECEIVED");
});

test("cross-merchant enumeration: probing sequential order ids under a different merchant's identity never reveals existence of another merchant's orders", async () => {
  const platform = twoMerchants();
  const customer = makeCustomer(platform);
  const orderB1 = await createOrder(platform, customer, "MERCHANT003");
  const orderB2 = await createOrder(platform, customer, "MERCHANT003");

  for (const id of [orderB1.id, orderB2.id, orderB1.id + 1000]) {
    assert.throws(() => platform.services.merchantOrders.getOrder("MERCHANT002", id), (err) => {
      assert.equal(err.code, "ORDER_NOT_FOUND"); // identical code whether the id exists (for another merchant) or not at all
      return true;
    });
  }
});

// --- M/N. error leakage / secret leakage --------------------------------

test("thrown MerchantOrderErrors never leak SQL text, file paths, stack traces or secrets in their message", async () => {
  const platform = twoMerchants();
  const customer = makeCustomer(platform);
  const order = await createOrder(platform, customer);

  const suspiciousPatterns = [
    /SQLITE/i, /\.db\b/i, /at Object\./, /at MerchantOrderService/, /at Function\./,
    /node_modules/, /\/home\//, /ENOENT/i, /API[_-]?KEY/i, /SECRET/i, /ANTHROPIC/i, /better-sqlite3/i,
  ];

  const attempts = [
    () => platform.services.merchantOrders.getOrder("MERCHANT002", "'; DROP TABLE orders; --"),
    () => platform.services.merchantOrders.getOrder("MERCHANT002", { $where: "1=1" }),
    () => platform.services.merchantOrders.receiveOrder("MERCHANT002", "1' UNION SELECT * FROM merchant_users --"),
    () => platform.services.merchantOrders.listOrders(null),
    () => platform.services.merchantAuth.verifyApiKey({}),
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
});

test("repository contains no committed secrets, .env files, or merchant-auth artifacts (automated scan)", () => {
  const tracked = execFileSync("git", ["ls-files"], { cwd: REPO_ROOT, encoding: "utf8" }).split("\n").filter(Boolean);
  const secretLikePatterns = [/(^|\/)\.env$/, /(^|\/)\.env\.(?!example$)/, /\.sqlite3?$/i, /(^|\/)platform\.db$/, /^data\/uploads\//];
  const offenders = tracked.filter((file) => secretLikePatterns.some((p) => p.test(file)));
  assert.deepEqual(offenders, []);
});

// --- O. subscription / inactive merchant access -------------------------

test("an INACTIVE (suspended) merchant can still authenticate and read its own already-existing orders — visibility of history is not revoked by subscription lapse", async () => {
  const platform = twoMerchants();
  const customer = makeCustomer(platform);
  const order = await createOrder(platform, customer);

  platform.repos.merchants.setStatus("MERCHANT002", "SUSPENDED");

  const fetched = platform.services.merchantOrders.getOrder("MERCHANT002", order.id);
  assert.equal(fetched.id, order.id);
  const list = platform.services.merchantOrders.listOrders("MERCHANT002");
  assert.equal(list.length, 1);
});

test("a suspended merchant still cannot receive NEW orders through the normal customer flow (unchanged Phase 6 behavior, not modified by Phase 7)", async () => {
  const platform = twoMerchants();
  const customer = makeCustomer(platform);
  const cart = platform.services.cart.createCart(customer.id, "MERCHANT002");
  const product = platform.services.menu.listProducts("MERCHANT002", { includeUnavailable: true })[0];
  platform.services.cart.addItem(customer.id, cart.id, "MERCHANT002", product.id, 1);

  platform.repos.merchants.setStatus("MERCHANT002", "SUSPENDED");

  await assert.rejects(() => platform.services.orders.confirmOrder(customer.id, cart.id), (err) => {
    assert.equal(err.code, "MERCHANT_NOT_ACTIVE");
    return true;
  });
});

// --- P/Q. concurrent / duplicate receive (CAS guard) ----------------------

test("concurrent receive: a customer cancellation racing between receiveOrder's two internal steps is detected as a conflict, never silently overwritten", async () => {
  const platform = twoMerchants();
  const customer = makeCustomer(platform);
  const order = await createOrder(platform, customer);

  const svc = platform.services.merchantOrders;
  const originalGuarded = svc._guardedSetStatus.bind(svc);
  let call = 0;
  svc._guardedSetStatus = (orderId, expected, next) => {
    call += 1;
    if (call === 1) {
      // Simulate a customer cancellation landing exactly between
      // receiveOrder's read and its first guarded write.
      platform.services.orders.cancelOrder(customer.id, orderId);
    }
    return originalGuarded(orderId, expected, next);
  };

  try {
    assert.throws(() => svc.receiveOrder("MERCHANT002", order.id), (err) => {
      assert.equal(err.code, "ORDER_STATE_CONFLICT");
      return true;
    });
  } finally {
    svc._guardedSetStatus = originalGuarded;
  }

  // The customer's cancellation wins — never silently overwritten to SENT_TO_MERCHANT.
  const finalState = platform.services.merchantOrders.getOrder("MERCHANT002", order.id);
  assert.equal(finalState.status, "CANCELLED");
});

test("duplicate receive: calling receiveOrder twice in immediate succession never creates a second transition or throws on the second call", async () => {
  const platform = twoMerchants();
  const customer = makeCustomer(platform);
  const order = await createOrder(platform, customer);

  const first = platform.services.merchantOrders.receiveOrder("MERCHANT002", order.id);
  const second = platform.services.merchantOrders.receiveOrder("MERCHANT002", order.id);
  assert.equal(first.status, "RECEIVED");
  assert.equal(second.status, "RECEIVED");
});
