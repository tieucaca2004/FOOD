import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTestPlatform } from "../helpers/testPlatform.js";
import { createPlatformRepositories } from "../../repositories/index.js";
import { createPlatformServices } from "../../services/index.js";

function twoMerchants() {
  return buildTestPlatform({ withAtieu: false, genericFixtureMerchants: ["MERCHANT002", "MERCHANT003"] });
}

function makeCustomer(platform, suffix = "") {
  return platform.services.customers.getOrCreateByZaloUserId(`cart-test-${Date.now()}-${Math.random()}${suffix}`, "Test Customer");
}

function m2Product(platform) {
  return platform.services.menu.listProducts("MERCHANT002", { includeUnavailable: true })[0]; // FIX2-HAISAN, 72000
}
function m3Product(platform) {
  return platform.services.menu.listProducts("MERCHANT003", { includeUnavailable: true })[0]; // FIX3-BO, 68000
}

// --- A. Cart lifecycle ------------------------------------------------

test("1. create cart", () => {
  const platform = twoMerchants();
  const customer = makeCustomer(platform);
  const cart = platform.services.cart.createCart(customer.id, "MERCHANT002");
  assert.equal(cart.merchant_id, "MERCHANT002");
  assert.equal(cart.customer_id, customer.id);
  assert.equal(cart.status, "ACTIVE");
});

test("2. get cart", () => {
  const platform = twoMerchants();
  const customer = makeCustomer(platform);
  const created = platform.services.cart.createCart(customer.id, "MERCHANT002");
  const fetched = platform.services.cart.getCart(customer.id, created.id);
  assert.equal(fetched.id, created.id);
});

test("3. getOrCreate cart is idempotent — returns the same cart on repeat calls", () => {
  const platform = twoMerchants();
  const customer = makeCustomer(platform);
  const first = platform.services.cart.getOrCreateCart(customer.id, "MERCHANT002");
  const second = platform.services.cart.getOrCreateCart(customer.id, "MERCHANT002");
  assert.equal(first.id, second.id);
});

test("4. a new cart is empty", () => {
  const platform = twoMerchants();
  const customer = makeCustomer(platform);
  const cart = platform.services.cart.createCart(customer.id, "MERCHANT002");
  assert.equal(cart.isEmpty, true);
  assert.equal(platform.services.cart.isEmpty(customer.id, cart.id), true);
});

test("5. clear cart empties items but keeps the cart ACTIVE", () => {
  const platform = twoMerchants();
  const customer = makeCustomer(platform);
  const product = m2Product(platform);
  const cart = platform.services.cart.createCart(customer.id, "MERCHANT002");
  platform.services.cart.addItem(customer.id, cart.id, "MERCHANT002", product.id, 2);

  const cleared = platform.services.cart.clearCart(customer.id, cart.id);
  assert.equal(cleared.items.length, 0);
  assert.equal(cleared.status, "ACTIVE");
});

// --- B. Add item --------------------------------------------------------

test("6. add an available product", () => {
  const platform = twoMerchants();
  const customer = makeCustomer(platform);
  const product = m2Product(platform);
  const cart = platform.services.cart.createCart(customer.id, "MERCHANT002");
  const result = platform.services.cart.addItem(customer.id, cart.id, "MERCHANT002", product.id, 2);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].quantity, 2);
});

test("7. adding the same product twice accumulates quantity (documented behavior)", () => {
  const platform = twoMerchants();
  const customer = makeCustomer(platform);
  const product = m2Product(platform);
  const cart = platform.services.cart.createCart(customer.id, "MERCHANT002");
  platform.services.cart.addItem(customer.id, cart.id, "MERCHANT002", product.id, 2);
  const result = platform.services.cart.addItem(customer.id, cart.id, "MERCHANT002", product.id, 3);
  assert.equal(result.items.length, 1); // no duplicate row
  assert.equal(result.items[0].quantity, 5);
});

test("8. add multiple different products", () => {
  const platform = twoMerchants();
  const customer = makeCustomer(platform);
  const cart = platform.services.cart.createCart(customer.id, "MERCHANT002");
  const catId = platform.services.menu.listCategories("MERCHANT002")[0].id;
  const second = platform.services.menu.createProduct("MERCHANT002", { sku: "M2-SECOND", name: "Món Thứ Hai", categoryId: catId, price: 30000 });

  platform.services.cart.addItem(customer.id, cart.id, "MERCHANT002", m2Product(platform).id, 1);
  const result = platform.services.cart.addItem(customer.id, cart.id, "MERCHANT002", second.id, 1);
  assert.equal(result.items.length, 2);
});

test("9. adding a nonexistent product is rejected", () => {
  const platform = twoMerchants();
  const customer = makeCustomer(platform);
  const cart = platform.services.cart.createCart(customer.id, "MERCHANT002");
  assert.throws(() => platform.services.cart.addItem(customer.id, cart.id, "MERCHANT002", 999999, 1), (err) => {
    assert.equal(err.code, "PRODUCT_NOT_FOUND");
    return true;
  });
});

test("10. adding an unavailable product is rejected", () => {
  const platform = twoMerchants();
  const customer = makeCustomer(platform);
  const product = m2Product(platform);
  platform.services.menu.setProductAvailability("MERCHANT002", product.id, false);
  const cart = platform.services.cart.createCart(customer.id, "MERCHANT002");
  assert.throws(() => platform.services.cart.addItem(customer.id, cart.id, "MERCHANT002", product.id, 1), (err) => {
    assert.equal(err.code, "PRODUCT_UNAVAILABLE");
    return true;
  });
});

test("11. invalid quantity is rejected on add", () => {
  const platform = twoMerchants();
  const customer = makeCustomer(platform);
  const product = m2Product(platform);
  const cart = platform.services.cart.createCart(customer.id, "MERCHANT002");
  for (const bad of [0, -1, 1.5, NaN, Infinity]) {
    assert.throws(() => platform.services.cart.addItem(customer.id, cart.id, "MERCHANT002", product.id, bad), (err) => {
      assert.equal(err.code, "INVALID_QUANTITY");
      return true;
    }, `quantity=${bad}`);
  }
});

// --- C. Quantity --------------------------------------------------------

test("12. update quantity", () => {
  const platform = twoMerchants();
  const customer = makeCustomer(platform);
  const product = m2Product(platform);
  const cart = platform.services.cart.createCart(customer.id, "MERCHANT002");
  const { items } = platform.services.cart.addItem(customer.id, cart.id, "MERCHANT002", product.id, 1);
  const result = platform.services.cart.updateItemQuantity(customer.id, cart.id, items[0].id, 5);
  assert.equal(result.items[0].quantity, 5);
});

test("13. updateItemQuantity(..., 0) removes the item (documented behavior)", () => {
  const platform = twoMerchants();
  const customer = makeCustomer(platform);
  const product = m2Product(platform);
  const cart = platform.services.cart.createCart(customer.id, "MERCHANT002");
  const { items } = platform.services.cart.addItem(customer.id, cart.id, "MERCHANT002", product.id, 1);
  const result = platform.services.cart.updateItemQuantity(customer.id, cart.id, items[0].id, 0);
  assert.equal(result.items.length, 0);
});

test("14. negative quantity is rejected on update", () => {
  const platform = twoMerchants();
  const customer = makeCustomer(platform);
  const product = m2Product(platform);
  const cart = platform.services.cart.createCart(customer.id, "MERCHANT002");
  const { items } = platform.services.cart.addItem(customer.id, cart.id, "MERCHANT002", product.id, 1);
  assert.throws(() => platform.services.cart.updateItemQuantity(customer.id, cart.id, items[0].id, -1), (err) => {
    assert.equal(err.code, "INVALID_QUANTITY");
    return true;
  });
});

test("15. fractional quantity is rejected on update", () => {
  const platform = twoMerchants();
  const customer = makeCustomer(platform);
  const product = m2Product(platform);
  const cart = platform.services.cart.createCart(customer.id, "MERCHANT002");
  const { items } = platform.services.cart.addItem(customer.id, cart.id, "MERCHANT002", product.id, 1);
  assert.throws(() => platform.services.cart.updateItemQuantity(customer.id, cart.id, items[0].id, 2.5), (err) => {
    assert.equal(err.code, "INVALID_QUANTITY");
    return true;
  });
});

// --- D. Remove ------------------------------------------------------------

test("16. remove item", () => {
  const platform = twoMerchants();
  const customer = makeCustomer(platform);
  const product = m2Product(platform);
  const cart = platform.services.cart.createCart(customer.id, "MERCHANT002");
  const { items } = platform.services.cart.addItem(customer.id, cart.id, "MERCHANT002", product.id, 1);
  const result = platform.services.cart.removeItem(customer.id, cart.id, items[0].id);
  assert.equal(result.items.length, 0);
});

test("17. removing a missing item is rejected", () => {
  const platform = twoMerchants();
  const customer = makeCustomer(platform);
  const cart = platform.services.cart.createCart(customer.id, "MERCHANT002");
  assert.throws(() => platform.services.cart.removeItem(customer.id, cart.id, 999999), (err) => {
    assert.equal(err.code, "CART_ITEM_NOT_FOUND");
    return true;
  });
});

// --- E. Totals --------------------------------------------------------

test("18. unit price always comes from the server's product record", () => {
  const platform = twoMerchants();
  const customer = makeCustomer(platform);
  const product = m2Product(platform);
  const cart = platform.services.cart.createCart(customer.id, "MERCHANT002");
  const { items } = platform.services.cart.addItem(customer.id, cart.id, "MERCHANT002", product.id, 1);
  assert.equal(items[0].unit_price, product.price);
});

test("19. per-item subtotal is unit_price × quantity, computed server-side", () => {
  const platform = twoMerchants();
  const customer = makeCustomer(platform);
  const product = m2Product(platform);
  const cart = platform.services.cart.createCart(customer.id, "MERCHANT002");
  const { items } = platform.services.cart.addItem(customer.id, cart.id, "MERCHANT002", product.id, 3);
  assert.equal(items[0].subtotal, product.price * 3);
});

test("20. cart total is the sum of all item subtotals", () => {
  const platform = twoMerchants();
  const customer = makeCustomer(platform);
  const catId = platform.services.menu.listCategories("MERCHANT002")[0].id;
  const second = platform.services.menu.createProduct("MERCHANT002", { sku: "M2-TOTALTEST", name: "Món B", categoryId: catId, price: 20000 });
  const cart = platform.services.cart.createCart(customer.id, "MERCHANT002");
  platform.services.cart.addItem(customer.id, cart.id, "MERCHANT002", m2Product(platform).id, 2); // 72000*2=144000
  const result = platform.services.cart.addItem(customer.id, cart.id, "MERCHANT002", second.id, 1); // 20000
  const totals = platform.services.cart.calculateTotals(customer.id, cart.id);
  assert.equal(result.total, 144000 + 20000);
  assert.equal(totals.subtotal, 144000 + 20000);
});

test("21. a client-supplied unit_price field is never read — server price always wins", () => {
  const platform = twoMerchants();
  const customer = makeCustomer(platform);
  const product = m2Product(platform);
  const cart = platform.services.cart.createCart(customer.id, "MERCHANT002");
  // addItem's signature has no price parameter at all — simulate an
  // attacker/AI passing extra fields via a spread; they're simply not
  // part of the call signature, so there is nothing to ignore-but-accept.
  const maliciousArgs = { unit_price: 1, price: 1 };
  const result = platform.services.cart.addItem(customer.id, cart.id, "MERCHANT002", product.id, 1, maliciousArgs);
  assert.equal(result.items[0].unit_price, product.price); // real price, not 1
});

test("22. a client-supplied subtotal is never read — server-computed subtotal always wins", () => {
  const platform = twoMerchants();
  const customer = makeCustomer(platform);
  const product = m2Product(platform);
  const cart = platform.services.cart.createCart(customer.id, "MERCHANT002");
  const result = platform.services.cart.addItem(customer.id, cart.id, "MERCHANT002", product.id, 2, { subtotal: 1 });
  assert.equal(result.items[0].subtotal, product.price * 2); // real subtotal, not 1
});

// --- F. Merchant isolation ------------------------------------------------

test("23. a product belonging to another merchant is rejected (PRODUCT_NOT_FOUND — MenuService's established non-leaking check, reused as-is)", () => {
  const platform = twoMerchants();
  const customer = makeCustomer(platform);
  const cart = platform.services.cart.createCart(customer.id, "MERCHANT002");
  const otherProduct = m3Product(platform);
  assert.throws(() => platform.services.cart.addItem(customer.id, cart.id, "MERCHANT002", otherProduct.id, 1), (err) => {
    assert.equal(err.code, "PRODUCT_NOT_FOUND");
    return true;
  });
});

test("24. using a cart that belongs to another merchant is rejected", () => {
  const platform = twoMerchants();
  const customer = makeCustomer(platform);
  const cartForM3 = platform.services.cart.createCart(customer.id, "MERCHANT003");
  // Caller claims MERCHANT002 but cartForM3 is actually MERCHANT003's.
  assert.throws(() => platform.services.cart.addItem(customer.id, cartForM3.id, "MERCHANT002", m2Product(platform).id, 1), (err) => {
    assert.equal(err.code, "CART_MERCHANT_MISMATCH");
    return true;
  });
});

test("25. explicit cross-merchant mismatch is rejected before any product lookup", () => {
  const platform = twoMerchants();
  const customer = makeCustomer(platform);
  const cart = platform.services.cart.createCart(customer.id, "MERCHANT002");
  assert.throws(() => platform.services.cart.addItem(customer.id, cart.id, "MERCHANT003", m3Product(platform).id, 1), (err) => {
    assert.equal(err.code, "CART_MERCHANT_MISMATCH");
    return true;
  });
});

test("26. an item id from a different cart cannot be accessed through another cart", () => {
  const platform = twoMerchants();
  const customer = makeCustomer(platform);
  const cartM2 = platform.services.cart.createCart(customer.id, "MERCHANT002");
  const cartM3 = platform.services.cart.createCart(customer.id, "MERCHANT003");
  const { items } = platform.services.cart.addItem(customer.id, cartM3.id, "MERCHANT003", m3Product(platform).id, 1);
  const m3ItemId = items[0].id;

  assert.throws(() => platform.services.cart.removeItem(customer.id, cartM2.id, m3ItemId), (err) => {
    assert.equal(err.code, "CART_ITEM_NOT_FOUND");
    return true;
  });
  assert.throws(() => platform.services.cart.updateItemQuantity(customer.id, cartM2.id, m3ItemId, 5), (err) => {
    assert.equal(err.code, "CART_ITEM_NOT_FOUND");
    return true;
  });
});

// --- G. Ownership -----------------------------------------------------

test("27. customer A cannot modify customer B's cart", () => {
  const platform = twoMerchants();
  const customerA = makeCustomer(platform, "a");
  const customerB = makeCustomer(platform, "b");
  const cartA = platform.services.cart.createCart(customerA.id, "MERCHANT002");
  assert.throws(() => platform.services.cart.addItem(customerB.id, cartA.id, "MERCHANT002", m2Product(platform).id, 1), (err) => {
    assert.equal(err.code, "CART_NOT_OWNED");
    return true;
  });
});

test("28. customer B cannot read customer A's cart", () => {
  const platform = twoMerchants();
  const customerA = makeCustomer(platform, "a");
  const customerB = makeCustomer(platform, "b");
  const cartA = platform.services.cart.createCart(customerA.id, "MERCHANT002");
  assert.throws(() => platform.services.cart.getCart(customerB.id, cartA.id), (err) => {
    assert.equal(err.code, "CART_NOT_OWNED");
    return true;
  });
});

test("29. customer B cannot remove an item from customer A's cart", () => {
  const platform = twoMerchants();
  const customerA = makeCustomer(platform, "a");
  const customerB = makeCustomer(platform, "b");
  const cartA = platform.services.cart.createCart(customerA.id, "MERCHANT002");
  const { items } = platform.services.cart.addItem(customerA.id, cartA.id, "MERCHANT002", m2Product(platform).id, 1);
  assert.throws(() => platform.services.cart.removeItem(customerB.id, cartA.id, items[0].id), (err) => {
    assert.equal(err.code, "CART_NOT_OWNED");
    return true;
  });
});

// --- H. Merchant status -------------------------------------------------

test("30. a SUSPENDED merchant rejects creation of a new cart", () => {
  const platform = twoMerchants();
  const customer = makeCustomer(platform);
  platform.repos.merchants.setStatus("MERCHANT002", "SUSPENDED");
  assert.throws(() => platform.services.cart.createCart(customer.id, "MERCHANT002"), (err) => {
    assert.equal(err.code, "MERCHANT_NOT_ACTIVE");
    return true;
  });
});

test("31. an EXPIRED merchant rejects creation of a new cart", () => {
  const platform = twoMerchants();
  const customer = makeCustomer(platform);
  platform.repos.merchants.setStatus("MERCHANT002", "EXPIRED");
  assert.throws(() => platform.services.cart.createCart(customer.id, "MERCHANT002"), (err) => {
    assert.equal(err.code, "MERCHANT_NOT_ACTIVE");
    return true;
  });
});

test("32. a valid ACTIVE merchant allows cart creation", () => {
  const platform = twoMerchants();
  const customer = makeCustomer(platform);
  const cart = platform.services.cart.createCart(customer.id, "MERCHANT002");
  assert.equal(cart.merchant_id, "MERCHANT002");
});

test("an existing cart still works even if its merchant later becomes inactive (discovery vs cart authorization differ, spec §12)", () => {
  const platform = twoMerchants();
  const customer = makeCustomer(platform);
  const cart = platform.services.cart.createCart(customer.id, "MERCHANT002");
  platform.services.cart.addItem(customer.id, cart.id, "MERCHANT002", m2Product(platform).id, 1);

  platform.repos.merchants.setStatus("MERCHANT002", "SUSPENDED");
  const fetched = platform.services.cart.getCart(customer.id, cart.id); // still readable
  assert.equal(fetched.items.length, 1);
});

// --- I. Persistence -----------------------------------------------------

test("33/34/35. cart + items + totals survive service recreation (same DB, fresh service instances)", () => {
  const platform = twoMerchants();
  const customer = makeCustomer(platform);
  const cart = platform.services.cart.createCart(customer.id, "MERCHANT002");
  const product = m2Product(platform);
  platform.services.cart.addItem(customer.id, cart.id, "MERCHANT002", product.id, 3);

  // Rebuild repositories/services from scratch against the SAME db
  // connection — proves state lives in SQLite, not in-memory service state.
  const freshRepos = createPlatformRepositories(platform.db);
  const freshServices = createPlatformServices(freshRepos, { visionProvider: platform.visionProvider, imageStorage: platform.imageStorage });

  const reloaded = freshServices.cart.getCart(customer.id, cart.id);
  assert.equal(reloaded.items.length, 1);
  assert.equal(reloaded.items[0].quantity, 3);
  assert.equal(reloaded.items[0].unit_price, product.price);
  assert.equal(reloaded.total, product.price * 3);
});
