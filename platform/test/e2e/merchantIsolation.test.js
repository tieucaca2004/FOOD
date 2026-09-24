// Cross-merchant isolation on the merchant-authenticated order routes, with
// two merchants that each have their own orders and their own API key.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTestPlatform, startServer, baseUrl, TEST_ADMIN_TOKEN } from "../helpers/testPlatform.js";

async function placeOrder(platform, merchantId, tag) {
  const customer = platform.services.customers.getOrCreateByZaloUserId(`iso-${tag}-${Math.random()}`, `Customer ${tag}`);
  const cart = platform.services.cart.createCart(customer.id, merchantId);
  const product = platform.services.menu.listProducts(merchantId, { includeUnavailable: true })[0];
  platform.services.cart.addItem(customer.id, cart.id, merchantId, product.id, 1);
  return platform.services.orders.confirmOrder(customer.id, cart.id);
}

async function withTwoMerchants(fn) {
  const platform = buildTestPlatform({ withAtieu: false, genericFixtureMerchants: ["MERCHANT002", "MERCHANT003"] });
  const server = await startServer(platform.app);
  try {
    const orderA = await placeOrder(platform, "MERCHANT002", "a");
    const orderB = await placeOrder(platform, "MERCHANT003", "b");
    const keyA = platform.services.merchantAuth.issueApiKey("MERCHANT002").apiKey;
    const keyB = platform.services.merchantAuth.issueApiKey("MERCHANT003").apiKey;
    const request = async (path, { key, method = "GET", body } = {}) => {
      const headers = { "content-type": "application/json" };
      if (key) headers.authorization = `Bearer ${key}`;
      const res = await fetch(`${baseUrl(server)}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await res.text();
      return { status: res.status, text, body: text ? JSON.parse(text) : null };
    };
    const statusOf = (orderId) => platform.db.prepare("SELECT status FROM orders WHERE id = ?").get(orderId).status;
    return await fn({ platform, orderA, orderB, keyA, keyB, request, statusOf });
  } finally {
    server.close();
  }
}

test("each merchant's order list contains only its own orders", async () => {
  await withTwoMerchants(async ({ orderA, orderB, keyA, keyB, request }) => {
    const listA = await request("/api/platform/merchant/orders", { key: keyA });
    assert.equal(listA.status, 200);
    assert.deepEqual(listA.body.orders.map((o) => o.id), [orderA.id]);
    assert.ok(listA.body.orders.every((o) => o.merchant_id === "MERCHANT002"));
    assert.ok(!listA.text.includes(orderB.order_code));

    const listB = await request("/api/platform/merchant/orders", { key: keyB });
    assert.deepEqual(listB.body.orders.map((o) => o.id), [orderB.id]);
    assert.ok(!listB.text.includes(orderA.order_code));
  });
});

test("another merchant's order looks exactly like a nonexistent one (no existence oracle)", async () => {
  await withTwoMerchants(async ({ orderB, keyA, request }) => {
    const foreign = await request(`/api/platform/merchant/orders/${orderB.id}`, { key: keyA });
    const missingId = orderB.id + 1000;
    const missing = await request(`/api/platform/merchant/orders/${missingId}`, { key: keyA });
    assert.equal(foreign.status, 404);
    assert.equal(missing.status, 404);
    assert.equal(foreign.text.replace(String(orderB.id), "N"), missing.text.replace(String(missingId), "N"));
    assert.ok(!foreign.text.includes("MERCHANT003"));
    assert.ok(!foreign.text.includes(orderB.order_code));
  });
});

test("a merchant cannot receive another merchant's order, and that order is left untouched", async () => {
  await withTwoMerchants(async ({ orderB, keyA, request, statusOf }) => {
    const before = statusOf(orderB.id);
    const res = await request(`/api/platform/merchant/orders/${orderB.id}/receive`, { key: keyA, method: "POST" });
    assert.equal(res.status, 404);
    assert.equal(statusOf(orderB.id), before);
  });
});

test("merchant_id supplied in the query string or body is ignored", async () => {
  await withTwoMerchants(async ({ orderA, orderB, keyA, request, statusOf }) => {
    for (const q of ["merchant_id=MERCHANT003", "merchantId=MERCHANT003", "merchant_id[]=MERCHANT003"]) {
      const list = await request(`/api/platform/merchant/orders?${q}`, { key: keyA });
      assert.deepEqual(list.body.orders.map((o) => o.id), [orderA.id], q);
      const get = await request(`/api/platform/merchant/orders/${orderB.id}?${q}`, { key: keyA });
      assert.equal(get.status, 404, q);
    }
    const before = statusOf(orderB.id);
    const receive = await request(`/api/platform/merchant/orders/${orderB.id}/receive`, {
      key: keyA,
      method: "POST",
      body: { merchant_id: "MERCHANT003", merchantId: "MERCHANT003" },
    });
    assert.equal(receive.status, 404);
    assert.equal(statusOf(orderB.id), before);
  });
});

test("malformed order ids return 404, never 500 and never another merchant's order", async () => {
  await withTwoMerchants(async ({ keyA, request }) => {
    for (const id of ["abc", "0", "-1", "1.5", "99999999999999999999", "NaN", "Infinity", "%00", "1;DROP"]) {
      const res = await request(`/api/platform/merchant/orders/${id}`, { key: keyA });
      assert.equal(res.status, 404, `${id} -> ${res.status} ${res.text}`);
      const receive = await request(`/api/platform/merchant/orders/${id}/receive`, { key: keyA, method: "POST" });
      assert.equal(receive.status, 404, `receive ${id} -> ${receive.status} ${receive.text}`);
    }
  });
});

test("re-issuing a merchant's key revokes the old key and leaves the other merchant's key working", async () => {
  await withTwoMerchants(async ({ platform, keyA, keyB, request }) => {
    const newKeyA = platform.services.merchantAuth.issueApiKey("MERCHANT002").apiKey;
    assert.notEqual(newKeyA, keyA);
    assert.equal((await request("/api/platform/merchant/orders", { key: keyA })).status, 401);
    assert.equal((await request("/api/platform/merchant/orders", { key: newKeyA })).status, 200);
    assert.equal((await request("/api/platform/merchant/orders", { key: keyB })).status, 200);
  });
});

test("merchant routes reject missing, malformed and unknown keys, and the admin token", async () => {
  await withTwoMerchants(async ({ keyA, request }) => {
    for (const key of [undefined, "mk_", keyA.slice(0, -1), keyA + "0", keyA.toUpperCase(), TEST_ADMIN_TOKEN]) {
      const res = await request("/api/platform/merchant/orders", { key });
      assert.equal(res.status, 401, String(key && key.slice(0, 4)));
      assert.deepEqual(res.body, { status: "error", error: "unauthenticated" });
    }
  });
});

test("path variants of the merchant routes cannot skip merchant authentication", async () => {
  await withTwoMerchants(async ({ orderA, request }) => {
    for (const path of [
      "/api/platform//merchant/orders",
      "/api/platform/MERCHANT/orders",
      "/api/platform/merchant/orders/",
      `/api/platform/Merchant/Orders/${orderA.id}`,
      "/api/platform/%6Derchant/orders",
    ]) {
      const res = await request(path);
      assert.ok(res.status === 401 || res.status === 404, `${path} -> ${res.status}`);
      assert.ok(!res.text.includes(orderA.order_code), `${path} leaked an order`);
    }
  });
});

test("the merchant order DTO exposes no internal identifiers", async () => {
  await withTwoMerchants(async ({ orderA, keyA, request }) => {
    const res = await request(`/api/platform/merchant/orders/${orderA.id}`, { key: keyA });
    const order = res.body.order;
    for (const field of ["customer_id", "cart_id", "zalo_user_id", "payment_status", "delivery_status", "api_key_hash"]) {
      assert.equal(Object.prototype.hasOwnProperty.call(order, field), false, field);
    }
    assert.deepEqual(Object.keys(order.customer).sort(), ["display_name", "phone"]);
  });
});
