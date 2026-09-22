import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTestContext, startServer, baseUrl } from "../helpers/testApp.js";

function zaloPayload({ zaloUserId, text, messageId }) {
  return {
    event_name: "user_send_text",
    sender: { id: zaloUserId },
    message: { text, msg_id: messageId },
    timestamp: Date.now(),
  };
}

test("webhook processes a text message end-to-end (no real Zalo credential — send is expected to fail cleanly)", async () => {
  const ctx = buildTestContext();
  const server = await startServer(ctx.app);
  try {
    const res = await fetch(`${baseUrl(server)}/zalo/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(zaloPayload({ zaloUserId: "wh-user-1", text: "Xin chào", messageId: "m-1" })),
    });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.status, "processed");
    assert.match(body.reply_text, /Mary/);
    // No ZALO_OA_ACCESS_TOKEN configured in test env -> send fails honestly,
    // never faked as delivered.
    assert.ok(body.respond_error);
  } finally {
    server.close();
  }
});

test("duplicate webhook (same message_id) is idempotent — does not reprocess or double-charge the cart", async () => {
  const ctx = buildTestContext();
  const server = await startServer(ctx.app);
  try {
    const payload = zaloPayload({ zaloUserId: "wh-user-2", text: "Cho 1 bò", messageId: "dup-1" });

    const res1 = await fetch(`${baseUrl(server)}/zalo/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body1 = await res1.json();

    const res2 = await fetch(`${baseUrl(server)}/zalo/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body2 = await res2.json();

    assert.deepEqual(body1, body2);

    const customer = ctx.repos.customers.findByZaloUserId("wh-user-2");
    const { items } = ctx.services.cart.getCart(customer.id);
    assert.equal(items.length, 1);
    assert.equal(items[0].quantity, 1); // added once, not twice
  } finally {
    server.close();
  }
});

test("non-text events (e.g. follow) are acked without being processed as chat", async () => {
  const ctx = buildTestContext();
  const server = await startServer(ctx.app);
  try {
    const res = await fetch(`${baseUrl(server)}/zalo/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event_name: "follow", sender: { id: "wh-user-3" } }),
    });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.status, "ignored");
  } finally {
    server.close();
  }
});

test("Zalo send API failure does not crash the webhook and is reported honestly, not as success", async () => {
  const ctx = buildTestContext();
  const server = await startServer(ctx.app);
  try {
    const res = await fetch(`${baseUrl(server)}/zalo/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(zaloPayload({ zaloUserId: "wh-user-4", text: "menu", messageId: "m-4" })),
    });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.status, "processed");
    assert.ok(body.respond_error); // no access token configured -> honest failure
  } finally {
    server.close();
  }
});

test("REST: cannot inject a client-supplied price/total — server always looks it up", async () => {
  const ctx = buildTestContext();
  const server = await startServer(ctx.app);
  try {
    const customer = ctx.repos.customers.create({ zaloUserId: "rest-user-1" });
    const bo = ctx.repos.products.findBySku("HTX-BO");

    const res = await fetch(`${baseUrl(server)}/api/cart/items`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ customerId: customer.id, productId: bo.id, quantity: 2, price: 1, total: 1 }),
    });
    const body = await res.json();
    assert.equal(res.status, 201);
    assert.equal(body.items[0].unit_price, 65000); // server price, client's "price":1 ignored
    assert.equal(body.total, 130000);
  } finally {
    server.close();
  }
});

test("REST: fake product id is rejected with 400, not silently accepted", async () => {
  const ctx = buildTestContext();
  const server = await startServer(ctx.app);
  try {
    const customer = ctx.repos.customers.create({ zaloUserId: "rest-user-2" });
    const res = await fetch(`${baseUrl(server)}/api/cart/items`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ customerId: customer.id, productId: 999999, quantity: 1 }),
    });
    assert.equal(res.status, 400);
  } finally {
    server.close();
  }
});

test("REST: order status transition rejects an invalid jump (DRAFT -> COMPLETED)", async () => {
  const ctx = buildTestContext();
  const server = await startServer(ctx.app);
  try {
    const customer = ctx.repos.customers.create({ zaloUserId: "rest-user-3" });
    const bo = ctx.repos.products.findBySku("HTX-BO");
    ctx.services.cart.addItem(customer.id, bo.id, 1);
    const cartView = ctx.services.cart.getCart(customer.id);
    const order = ctx.services.orders.startCheckout(customer, cartView.cart, cartView.items);

    const res = await fetch(`${baseUrl(server)}/api/orders/${order.id}/status`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "COMPLETED" }),
    });
    assert.equal(res.status, 409);
  } finally {
    server.close();
  }
});

test("health and readiness endpoints respond", async () => {
  const ctx = buildTestContext();
  const server = await startServer(ctx.app);
  try {
    const health = await fetch(`${baseUrl(server)}/api/health`);
    assert.equal(health.status, 200);
    const ready = await fetch(`${baseUrl(server)}/api/readiness`);
    assert.equal(ready.status, 200);
  } finally {
    server.close();
  }
});

test("database failure on readiness check is reported as not_ready, not faked as healthy", async () => {
  const ctx = buildTestContext();
  ctx.db.close(); // simulate DB unavailable
  const server = await startServer(ctx.app);
  try {
    const res = await fetch(`${baseUrl(server)}/api/readiness`);
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.status, "not_ready");
  } finally {
    server.close();
  }
});
