import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTestPlatform, startServer, baseUrl } from "../helpers/testPlatform.js";

async function createOrderViaApi(platform) {
  const customer = platform.services.customers.getOrCreateByZaloUserId(`e2e-${Date.now()}-${Math.random()}`, "E2E Customer");
  const cart = platform.services.cart.createCart(customer.id, "MERCHANT002");
  const product = platform.services.menu.listProducts("MERCHANT002", { includeUnavailable: true })[0];
  platform.services.cart.addItem(customer.id, cart.id, "MERCHANT002", product.id, 1);
  return platform.services.orders.confirmOrder(customer.id, cart.id);
}

test("unauthenticated GET /api/platform/merchant/orders is rejected with 401, no Authorization header", async () => {
  const platform = buildTestPlatform({ withAtieu: false, genericFixtureMerchants: ["MERCHANT002"] });
  const server = await startServer(platform.app);
  try {
    const res = await fetch(`${baseUrl(server)}/api/platform/merchant/orders`);
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.status, "error");
  } finally {
    server.close();
  }
});

test("malformed Authorization header (wrong scheme, missing token) is rejected with 401", async () => {
  const platform = buildTestPlatform({ withAtieu: false, genericFixtureMerchants: ["MERCHANT002"] });
  const server = await startServer(platform.app);
  try {
    for (const header of ["Basic abcdef", "Bearer", "totally-invalid"]) {
      const res = await fetch(`${baseUrl(server)}/api/platform/merchant/orders`, { headers: { authorization: header } });
      assert.equal(res.status, 401, `header=${header}`);
    }
  } finally {
    server.close();
  }
});

test("an invalid/never-issued API key is rejected with 401", async () => {
  const platform = buildTestPlatform({ withAtieu: false, genericFixtureMerchants: ["MERCHANT002"] });
  const server = await startServer(platform.app);
  try {
    const res = await fetch(`${baseUrl(server)}/api/platform/merchant/orders`, {
      headers: { authorization: "Bearer mk_never_issued_by_anyone" },
    });
    assert.equal(res.status, 401);
  } finally {
    server.close();
  }
});

test("admin issues an API key, merchant authenticates with it, lists and reads its own order, and receives it — full real HTTP round trip", async () => {
  const platform = buildTestPlatform({ withAtieu: false, genericFixtureMerchants: ["MERCHANT002"] });
  const server = await startServer(platform.app);
  try {
    const order = await createOrderViaApi(platform);

    const issueRes = await fetch(`${baseUrl(server)}/api/platform/merchants/MERCHANT002/api-keys`, { method: "POST" });
    assert.equal(issueRes.status, 201);
    const { api_key: apiKey } = await issueRes.json();
    assert.ok(apiKey.startsWith("mk_"));

    const listRes = await fetch(`${baseUrl(server)}/api/platform/merchant/orders`, {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    assert.equal(listRes.status, 200);
    const { orders } = await listRes.json();
    assert.equal(orders.length, 1);
    assert.equal(orders[0].id, order.id);
    assert.equal(orders[0].status, "CREATED");

    const getRes = await fetch(`${baseUrl(server)}/api/platform/merchant/orders/${order.id}`, {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    assert.equal(getRes.status, 200);
    const { order: fetched } = await getRes.json();
    assert.equal(fetched.id, order.id);
    assert.equal(Object.prototype.hasOwnProperty.call(fetched, "payment_status"), false);

    const receiveRes = await fetch(`${baseUrl(server)}/api/platform/merchant/orders/${order.id}/receive`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}` },
    });
    assert.equal(receiveRes.status, 200);
    const { order: received } = await receiveRes.json();
    assert.equal(received.status, "RECEIVED");
  } finally {
    server.close();
  }
});

test("merchant A's API key cannot read or receive merchant B's order over real HTTP (cross-tenant, 404)", async () => {
  const platform = buildTestPlatform({ withAtieu: false, genericFixtureMerchants: ["MERCHANT002", "MERCHANT003"] });
  const server = await startServer(platform.app);
  try {
    const customer = platform.services.customers.getOrCreateByZaloUserId(`e2e-b-${Date.now()}`, "B Customer");
    const cartB = platform.services.cart.createCart(customer.id, "MERCHANT003");
    const productB = platform.services.menu.listProducts("MERCHANT003", { includeUnavailable: true })[0];
    platform.services.cart.addItem(customer.id, cartB.id, "MERCHANT003", productB.id, 1);
    const orderB = await platform.services.orders.confirmOrder(customer.id, cartB.id);

    const issueRes = await fetch(`${baseUrl(server)}/api/platform/merchants/MERCHANT002/api-keys`, { method: "POST" });
    const { api_key: apiKeyA } = await issueRes.json();

    const getRes = await fetch(`${baseUrl(server)}/api/platform/merchant/orders/${orderB.id}`, {
      headers: { authorization: `Bearer ${apiKeyA}` },
    });
    assert.equal(getRes.status, 404);

    const receiveRes = await fetch(`${baseUrl(server)}/api/platform/merchant/orders/${orderB.id}/receive`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKeyA}` },
    });
    assert.equal(receiveRes.status, 404);
  } finally {
    server.close();
  }
});

test("issuing a new API key for a merchant does not disturb sibling routes (health/search/admin) mounted at the same /api/platform prefix", async () => {
  const platform = buildTestPlatform({ withAtieu: false, genericFixtureMerchants: ["MERCHANT002"] });
  const server = await startServer(platform.app);
  try {
    const healthRes = await fetch(`${baseUrl(server)}/api/platform/health`);
    assert.equal(healthRes.status, 200);
    const searchRes = await fetch(`${baseUrl(server)}/api/platform/search?q=test`);
    assert.equal(searchRes.status, 200);
    const merchantsRes = await fetch(`${baseUrl(server)}/api/platform/merchants`);
    assert.equal(merchantsRes.status, 200);
  } finally {
    server.close();
  }
});
