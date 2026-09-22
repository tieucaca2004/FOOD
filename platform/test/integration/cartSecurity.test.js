// Phase 5 SECURITY GATE — mandatory security test matrix (spec §58, items
// 39-60: 22 scenarios on top of the 38 functional scenarios already
// covered by cartService.test.js). This file is the automated evidence
// for the Security section of the Final Report (spec §63) — every claim
// made there ("IDOR protection: PASS", "SQL injection: PASS", etc.) is
// backed by a specific test below, not by manual review alone.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildTestPlatform } from "../helpers/testPlatform.js";
import { platformConfig } from "../../config.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function twoMerchants() {
  return buildTestPlatform({ withAtieu: false, genericFixtureMerchants: ["MERCHANT002", "MERCHANT003"] });
}

function makeCustomer(platform, suffix = "") {
  return platform.services.customers.getOrCreateByZaloUserId(`cart-sec-test-${Date.now()}-${Math.random()}${suffix}`, "Test Customer");
}

function m2Product(platform) {
  return platform.services.menu.listProducts("MERCHANT002", { includeUnavailable: true })[0];
}
function m3Product(platform) {
  return platform.services.menu.listProducts("MERCHANT003", { includeUnavailable: true })[0];
}

// --- IDOR / cross-user (39-42) --------------------------------------------

test("39. cross-user cart READ is rejected (IDOR)", () => {
  const platform = twoMerchants();
  const owner = makeCustomer(platform, "owner");
  const attacker = makeCustomer(platform, "attacker");
  const cart = platform.services.cart.createCart(owner.id, "MERCHANT002");
  platform.services.cart.addItem(owner.id, cart.id, "MERCHANT002", m2Product(platform).id, 1);

  assert.throws(() => platform.services.cart.getCart(attacker.id, cart.id), (err) => {
    assert.equal(err.code, "CART_NOT_OWNED");
    return true;
  });
});

test("40. cross-user cart item UPDATE is rejected (IDOR)", () => {
  const platform = twoMerchants();
  const owner = makeCustomer(platform, "owner");
  const attacker = makeCustomer(platform, "attacker");
  const cart = platform.services.cart.createCart(owner.id, "MERCHANT002");
  const { items } = platform.services.cart.addItem(owner.id, cart.id, "MERCHANT002", m2Product(platform).id, 1);

  assert.throws(() => platform.services.cart.updateItemQuantity(attacker.id, cart.id, items[0].id, 99), (err) => {
    assert.equal(err.code, "CART_NOT_OWNED");
    return true;
  });
  // Prove the attempt had no effect.
  const stillOwners = platform.services.cart.getCart(owner.id, cart.id);
  assert.equal(stillOwners.items[0].quantity, 1);
});

test("41. cross-user cart item DELETE is rejected (IDOR)", () => {
  const platform = twoMerchants();
  const owner = makeCustomer(platform, "owner");
  const attacker = makeCustomer(platform, "attacker");
  const cart = platform.services.cart.createCart(owner.id, "MERCHANT002");
  const { items } = platform.services.cart.addItem(owner.id, cart.id, "MERCHANT002", m2Product(platform).id, 1);

  assert.throws(() => platform.services.cart.removeItem(attacker.id, cart.id, items[0].id), (err) => {
    assert.equal(err.code, "CART_NOT_OWNED");
    return true;
  });
  const stillThere = platform.services.cart.getCart(owner.id, cart.id);
  assert.equal(stillThere.items.length, 1);
});

test("42. cross-user clearCart is rejected (IDOR)", () => {
  const platform = twoMerchants();
  const owner = makeCustomer(platform, "owner");
  const attacker = makeCustomer(platform, "attacker");
  const cart = platform.services.cart.createCart(owner.id, "MERCHANT002");
  platform.services.cart.addItem(owner.id, cart.id, "MERCHANT002", m2Product(platform).id, 1);

  assert.throws(() => platform.services.cart.clearCart(attacker.id, cart.id), (err) => {
    assert.equal(err.code, "CART_NOT_OWNED");
    return true;
  });
  const stillThere = platform.services.cart.getCart(owner.id, cart.id);
  assert.equal(stillThere.items.length, 1);
});

// --- Tenant isolation (43-44) ----------------------------------------------

test("43. adding a product that belongs to a different merchant is rejected, not silently mixed into the cart", () => {
  const platform = twoMerchants();
  const customer = makeCustomer(platform);
  const cart = platform.services.cart.createCart(customer.id, "MERCHANT002");

  assert.throws(() => platform.services.cart.addItem(customer.id, cart.id, "MERCHANT002", m3Product(platform).id, 1), (err) => {
    assert.equal(err.code, "PRODUCT_NOT_FOUND");
    return true;
  });
  assert.equal(platform.services.cart.getCart(customer.id, cart.id).items.length, 0);
});

test("44. a forged merchantId that disagrees with the cart's real (server-recorded) merchant is rejected before any product lookup", () => {
  const platform = twoMerchants();
  const customer = makeCustomer(platform);
  const cart = platform.services.cart.createCart(customer.id, "MERCHANT002"); // real merchant_id is MERCHANT002, server-authoritative

  // Attacker claims MERCHANT003 while targeting MERCHANT002's cart, hoping
  // to smuggle a MERCHANT003 product in, or to probe MERCHANT003 pricing.
  assert.throws(() => platform.services.cart.addItem(customer.id, cart.id, "MERCHANT003", m3Product(platform).id, 1), (err) => {
    assert.equal(err.code, "CART_MERCHANT_MISMATCH");
    return true;
  });
  assert.equal(platform.services.cart.getCart(customer.id, cart.id).items.length, 0);
  assert.equal(platform.services.cart.getCart(customer.id, cart.id).merchant_id, "MERCHANT002"); // unchanged
});

// --- Price / subtotal / status tampering (45-47) ---------------------------

test("45. forged unit_price is never honored, even at extreme values (1 or 999,999,999)", () => {
  const platform = twoMerchants();
  const customer = makeCustomer(platform);
  const product = m2Product(platform);
  const cart = platform.services.cart.createCart(customer.id, "MERCHANT002");

  // addItem's signature is (customerId, cartId, merchantId, productId,
  // quantity) — there is no price parameter to forge. Extra positional
  // arguments are simply unread; passing them here proves that, rather
  // than assuming it.
  const result = platform.services.cart.addItem(customer.id, cart.id, "MERCHANT002", product.id, 1, { unit_price: 1, price: 999999999 });
  assert.equal(result.items[0].unit_price, product.price);
  assert.notEqual(result.items[0].unit_price, 1);
  assert.notEqual(result.items[0].unit_price, 999999999);
});

test("46. forged subtotal is never honored — subtotal is always server-computed unit_price * quantity", () => {
  const platform = twoMerchants();
  const customer = makeCustomer(platform);
  const product = m2Product(platform);
  const cart = platform.services.cart.createCart(customer.id, "MERCHANT002");

  const result = platform.services.cart.addItem(customer.id, cart.id, "MERCHANT002", product.id, 4, { subtotal: 1 });
  assert.equal(result.items[0].subtotal, product.price * 4);
  assert.equal(result.total, product.price * 4);
});

test("47. there is no call path that lets a caller set cart/item status directly (structural mass-assignment prevention)", () => {
  const platform = twoMerchants();
  const customer = makeCustomer(platform);
  const cart = platform.services.cart.createCart(customer.id, "MERCHANT002");
  const product = m2Product(platform);

  platform.services.cart.addItem(customer.id, cart.id, "MERCHANT002", product.id, 1, { status: "COMPLETED" });
  platform.services.cart.updateItemQuantity(customer.id, cart.id, platform.services.cart.getCart(customer.id, cart.id).items[0].id, 2, { status: "CHECKED_OUT" });

  const fetched = platform.services.cart.getCart(customer.id, cart.id);
  assert.equal(fetched.status, "ACTIVE"); // never moved despite the forged extra argument
});

// --- SQL injection (48-50) --------------------------------------------------

const SQLI_PAYLOADS = ["' OR 1=1 --", "'; DROP TABLE merchant_carts; --", "1' UNION SELECT * FROM merchants --"];

test("48. SQL-injection-shaped cartId values are rejected safely (parameterized queries hold, no DB corruption)", () => {
  const platform = twoMerchants();
  const customer = makeCustomer(platform);
  const cart = platform.services.cart.createCart(customer.id, "MERCHANT002");
  platform.services.cart.addItem(customer.id, cart.id, "MERCHANT002", m2Product(platform).id, 1);

  for (const payload of SQLI_PAYLOADS) {
    assert.throws(() => platform.services.cart.getCart(customer.id, payload), (err) => {
      assert.equal(err.code, "CART_NOT_FOUND");
      return true;
    }, `payload=${payload}`);
  }
  // Table still exists and the real cart/items are untouched.
  const stillThere = platform.services.cart.getCart(customer.id, cart.id);
  assert.equal(stillThere.items.length, 1);
});

test("49. SQL-injection-shaped productId values are rejected safely", () => {
  const platform = twoMerchants();
  const customer = makeCustomer(platform);
  const cart = platform.services.cart.createCart(customer.id, "MERCHANT002");

  for (const payload of SQLI_PAYLOADS) {
    assert.throws(() => platform.services.cart.addItem(customer.id, cart.id, "MERCHANT002", payload, 1), (err) => {
      assert.equal(err.code, "PRODUCT_NOT_FOUND");
      return true;
    }, `payload=${payload}`);
  }
  assert.equal(platform.services.cart.getCart(customer.id, cart.id).items.length, 0);
});

test("50. SQL-injection-shaped merchantId values are rejected safely", () => {
  const platform = twoMerchants();
  const customer = makeCustomer(platform);
  const cart = platform.services.cart.createCart(customer.id, "MERCHANT002");

  for (const payload of SQLI_PAYLOADS) {
    // Non-empty string, so it clears requireNonEmptyString and reaches the
    // real merchant-mismatch/not-found checks — proving the string is used
    // only as a bound parameter, never concatenated into SQL.
    assert.throws(() => platform.services.cart.addItem(customer.id, cart.id, payload, m2Product(platform).id, 1), (err) => {
      assert.ok(["CART_MERCHANT_MISMATCH", "MERCHANT_NOT_FOUND"].includes(err.code), `unexpected code ${err.code}`);
      return true;
    }, `payload=${payload}`);
  }
  // The merchants table is intact — createCart against a real merchant still works.
  assert.doesNotThrow(() => platform.services.cart.createCart(customer.id, "MERCHANT003"));
});

// --- Malformed / abusive quantity (51-56) -----------------------------------

test("51. malformed quantity types (null, undefined, string, object, array, boolean) are all rejected on addItem", () => {
  const platform = twoMerchants();
  const customer = makeCustomer(platform);
  const cart = platform.services.cart.createCart(customer.id, "MERCHANT002");
  const product = m2Product(platform);

  for (const bad of [null, undefined, "5", {}, [], true, "5 OR 1=1"]) {
    assert.throws(() => platform.services.cart.addItem(customer.id, cart.id, "MERCHANT002", product.id, bad), (err) => {
      assert.equal(err.code, "INVALID_QUANTITY");
      return true;
    }, `quantity=${JSON.stringify(bad)}`);
  }
  assert.equal(platform.services.cart.getCart(customer.id, cart.id).items.length, 0);
});

test("52. NaN / Infinity / -Infinity quantity is rejected on both addItem and updateItemQuantity", () => {
  const platform = twoMerchants();
  const customer = makeCustomer(platform);
  const cart = platform.services.cart.createCart(customer.id, "MERCHANT002");
  const product = m2Product(platform);

  for (const bad of [NaN, Infinity, -Infinity]) {
    assert.throws(() => platform.services.cart.addItem(customer.id, cart.id, "MERCHANT002", product.id, bad), (err) => {
      assert.equal(err.code, "INVALID_QUANTITY");
      return true;
    }, `add quantity=${bad}`);
  }

  const { items } = platform.services.cart.addItem(customer.id, cart.id, "MERCHANT002", product.id, 1);
  for (const bad of [NaN, Infinity, -Infinity]) {
    assert.throws(() => platform.services.cart.updateItemQuantity(customer.id, cart.id, items[0].id, bad), (err) => {
      assert.equal(err.code, "INVALID_QUANTITY");
      return true;
    }, `update quantity=${bad}`);
  }
  assert.equal(platform.services.cart.getCart(customer.id, cart.id).items[0].quantity, 1); // unchanged
});

test("53. negative quantity is rejected on both addItem and updateItemQuantity", () => {
  const platform = twoMerchants();
  const customer = makeCustomer(platform);
  const cart = platform.services.cart.createCart(customer.id, "MERCHANT002");
  const product = m2Product(platform);

  assert.throws(() => platform.services.cart.addItem(customer.id, cart.id, "MERCHANT002", product.id, -3), (err) => {
    assert.equal(err.code, "INVALID_QUANTITY");
    return true;
  });
  const { items } = platform.services.cart.addItem(customer.id, cart.id, "MERCHANT002", product.id, 1);
  assert.throws(() => platform.services.cart.updateItemQuantity(customer.id, cart.id, items[0].id, -3), (err) => {
    assert.equal(err.code, "INVALID_QUANTITY");
    return true;
  });
});

test("54. fractional quantity is rejected on both addItem and updateItemQuantity", () => {
  const platform = twoMerchants();
  const customer = makeCustomer(platform);
  const cart = platform.services.cart.createCart(customer.id, "MERCHANT002");
  const product = m2Product(platform);

  assert.throws(() => platform.services.cart.addItem(customer.id, cart.id, "MERCHANT002", product.id, 1.5), (err) => {
    assert.equal(err.code, "INVALID_QUANTITY");
    return true;
  });
  const { items } = platform.services.cart.addItem(customer.id, cart.id, "MERCHANT002", product.id, 1);
  assert.throws(() => platform.services.cart.updateItemQuantity(customer.id, cart.id, items[0].id, 2.5), (err) => {
    assert.equal(err.code, "INVALID_QUANTITY");
    return true;
  });
});

test("55. quantity above the configured maximum (cartMaxItemQuantity) is rejected on addItem", () => {
  const platform = twoMerchants();
  const customer = makeCustomer(platform);
  const cart = platform.services.cart.createCart(customer.id, "MERCHANT002");
  const product = m2Product(platform);

  assert.throws(() => platform.services.cart.addItem(customer.id, cart.id, "MERCHANT002", product.id, platformConfig.cartMaxItemQuantity + 1), (err) => {
    assert.equal(err.code, "INVALID_QUANTITY");
    return true;
  });
  assert.doesNotThrow(() => platform.services.cart.addItem(customer.id, cart.id, "MERCHANT002", product.id, platformConfig.cartMaxItemQuantity));
});

test("56. accumulated quantity exceeding the configured maximum across two addItem calls is rejected, with no partial update applied", () => {
  const platform = twoMerchants();
  const customer = makeCustomer(platform);
  const cart = platform.services.cart.createCart(customer.id, "MERCHANT002");
  const product = m2Product(platform);
  const max = platformConfig.cartMaxItemQuantity;

  platform.services.cart.addItem(customer.id, cart.id, "MERCHANT002", product.id, max - 1);
  assert.throws(() => platform.services.cart.addItem(customer.id, cart.id, "MERCHANT002", product.id, 2), (err) => {
    assert.equal(err.code, "INVALID_QUANTITY");
    return true;
  });
  // Still the pre-attempt quantity — the second call's partial effect never landed.
  assert.equal(platform.services.cart.getCart(customer.id, cart.id).items[0].quantity, max - 1);
});

// --- Resource abuse (57) ----------------------------------------------------

test("57. adding more than the configured maximum number of distinct products (cartMaxItems) is rejected", () => {
  const platform = twoMerchants();
  const customer = makeCustomer(platform);
  const cart = platform.services.cart.createCart(customer.id, "MERCHANT002");
  const catId = platform.services.menu.listCategories("MERCHANT002")[0].id;
  const max = platformConfig.cartMaxItems;

  for (let i = 0; i < max; i++) {
    const product = platform.services.menu.createProduct("MERCHANT002", { sku: `M2-BULK-${i}`, name: `Món ${i}`, categoryId: catId, price: 10000 });
    platform.services.cart.addItem(customer.id, cart.id, "MERCHANT002", product.id, 1);
  }
  assert.equal(platform.services.cart.getCart(customer.id, cart.id).items.length, max);

  const overflow = platform.services.menu.createProduct("MERCHANT002", { sku: "M2-OVERFLOW", name: "Overflow", categoryId: catId, price: 10000 });
  assert.throws(() => platform.services.cart.addItem(customer.id, cart.id, "MERCHANT002", overflow.id, 1), (err) => {
    assert.equal(err.code, "CART_ITEM_LIMIT_EXCEEDED");
    return true;
  });
  assert.equal(platform.services.cart.getCart(customer.id, cart.id).items.length, max); // still exactly the limit, no overflow row
});

// --- Unauthorized item access via guessed ids (58) --------------------------

test("58. a guessed/sequential itemId belonging to another customer's cart cannot be read, updated or removed through a cart the caller does own", () => {
  const platform = twoMerchants();
  const victim = makeCustomer(platform, "victim");
  const attacker = makeCustomer(platform, "attacker");

  const victimCart = platform.services.cart.createCart(victim.id, "MERCHANT002");
  const { items: victimItems } = platform.services.cart.addItem(victim.id, victimCart.id, "MERCHANT002", m2Product(platform).id, 1);
  const victimItemId = victimItems[0].id;

  // Attacker owns their own, unrelated cart with the SAME merchant, then
  // tries to reach the victim's item id through their own (owned) cart.
  const attackerCart = platform.services.cart.createCart(attacker.id, "MERCHANT002");

  assert.throws(() => platform.services.cart.getItem(attacker.id, attackerCart.id, victimItemId), (err) => {
    assert.equal(err.code, "CART_ITEM_NOT_FOUND"); // never CART_NOT_OWNED — no cross-cart existence leak either
    return true;
  });
  assert.throws(() => platform.services.cart.updateItemQuantity(attacker.id, attackerCart.id, victimItemId, 9), (err) => {
    assert.equal(err.code, "CART_ITEM_NOT_FOUND");
    return true;
  });
  assert.throws(() => platform.services.cart.removeItem(attacker.id, attackerCart.id, victimItemId), (err) => {
    assert.equal(err.code, "CART_ITEM_NOT_FOUND");
    return true;
  });

  // Victim's item survives every attempt untouched.
  const stillThere = platform.services.cart.getCart(victim.id, victimCart.id);
  assert.equal(stillThere.items.length, 1);
  assert.equal(stillThere.items[0].quantity, 1);
});

// --- Transaction integrity (59) ---------------------------------------------

test("59. a failure mid-transaction during addItem leaves no partial state (transaction rollback integrity)", () => {
  const platform = twoMerchants();
  const customer = makeCustomer(platform);
  const cart = platform.services.cart.createCart(customer.id, "MERCHANT002");
  const product = m2Product(platform);
  platform.services.cart.addItem(customer.id, cart.id, "MERCHANT002", product.id, 2);

  const cartRepo = platform.services.cart.repos.carts;
  const originalTouch = cartRepo.touch.bind(cartRepo);
  cartRepo.touch = () => {
    throw new Error("simulated failure mid-transaction");
  };

  try {
    assert.throws(() => platform.services.cart.addItem(customer.id, cart.id, "MERCHANT002", product.id, 3), /simulated failure/);
  } finally {
    cartRepo.touch = originalTouch;
  }

  // setItemQuantity ran before the simulated touch() failure inside the
  // SAME db.transaction() — if the transaction is truly atomic, that write
  // must have rolled back too. Quantity must still be the pre-attempt 2,
  // never the partially-applied 5.
  const items = platform.services.cart.listItems(customer.id, cart.id);
  assert.equal(items.length, 1);
  assert.equal(items[0].quantity, 2);
});

// --- Error leakage + secret/artifact scan (60) ------------------------------

test("60a. thrown CartErrors never leak SQL text, file paths, stack traces or secrets in their message", () => {
  const platform = twoMerchants();
  const customer = makeCustomer(platform);
  const cart = platform.services.cart.createCart(customer.id, "MERCHANT002");

  const suspiciousPatterns = [
    /SQLITE/i,
    /\.db\b/i,
    /at Object\./,
    /at CartService/,
    /at Function\./,
    /node_modules/,
    /\/home\//,
    /ENOENT/i,
    /API[_-]?KEY/i,
    /SECRET/i,
    /ANTHROPIC/i,
    /better-sqlite3/i,
  ];

  const attempts = [
    () => platform.services.cart.getCart(customer.id, "'; DROP TABLE merchant_carts; --"),
    () => platform.services.cart.getCart(customer.id, { $where: "1=1" }),
    () => platform.services.cart.addItem(customer.id, cart.id, "MERCHANT002", "' OR 1=1 --", 1),
    () => platform.services.cart.addItem(customer.id, cart.id, "MERCHANT002", m2Product(platform).id, "1 OR 1=1"),
    () => platform.services.cart.addItem(customer.id, cart.id, "1' UNION SELECT * FROM merchants --", m2Product(platform).id, 1),
    () => platform.services.cart.updateItemQuantity(customer.id, cart.id, 999999, NaN),
    () => platform.services.cart.removeItem(customer.id, cart.id, {}),
    () => platform.services.cart.createCart(customer.id, null),
    () => platform.services.cart.createCart(undefined, "MERCHANT002"),
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

test("60b. repository contains no committed secrets, .env files, or cart/menu-import DB/upload artifacts (automated scan)", () => {
  const tracked = execFileSync("git", ["ls-files"], { cwd: REPO_ROOT, encoding: "utf8" })
    .split("\n")
    .filter(Boolean);

  const secretLikePatterns = [
    /(^|\/)\.env$/, // a real .env, never .env.example
    /(^|\/)\.env\.(?!example$)/, // .env.local, .env.production, etc — but not .env.example
    /\.sqlite3?$/i,
    /(^|\/)platform\.db$/,
    /^data\/uploads\//, // uploaded menu-import images (gitignored — should never be tracked)
  ];

  const offenders = tracked.filter((file) => secretLikePatterns.some((pattern) => pattern.test(file)));
  assert.deepEqual(offenders, [], `unexpected committed artifact(s): ${offenders.join(", ")}`);
});
