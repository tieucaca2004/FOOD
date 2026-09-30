import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTestPlatform, startServer, baseUrl, ADMIN_AUTH_HEADER } from "../helpers/testPlatform.js";

function zaloPayload({ zaloUserId, text, messageId }) {
  return { event_name: "user_send_text", sender: { id: zaloUserId }, message: { text, msg_id: messageId }, timestamp: Date.now() };
}

async function sendText(server, { zaloUserId, text, messageId }) {
  const res = await fetch(`${baseUrl(server)}/platform/webhook`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(zaloPayload({ zaloUserId, text, messageId })),
  });
  return { status: res.status, body: await res.json() };
}

test("ACCEPTANCE §33 over real HTTP: full webhook-driven flow ends with a CONFIRMED A Tiểu order", async () => {
  const platform = buildTestPlatform();
  const server = await startServer(platform.app);
  const zaloUserId = "wh-e2e-1";
  try {
    let r = await sendText(server, { zaloUserId, text: "Xin chào", messageId: "m1" });
    assert.equal(r.body.status, "processed");

    r = await sendText(server, { zaloUserId, text: "Tôi muốn ăn hủ tiếu xào.", messageId: "m2" });
    assert.match(r.body.reply_text, /A TIỂU/i);

    r = await sendText(server, { zaloUserId, text: "Xem A Tiểu", messageId: "m3" });
    assert.match(r.body.reply_text, /Đã mở/);

    r = await sendText(server, { zaloUserId, text: "Cho tôi 2 hủ tiếu xào bò", messageId: "m4" });
    assert.match(r.body.reply_text, /× 2/);

    r = await sendText(server, { zaloUserId, text: "Đặt", messageId: "m5" });
    r = await sendText(server, { zaloUserId, text: "Mang về", messageId: "m6" });
    r = await sendText(server, { zaloUserId, text: "0912345678", messageId: "m7" });
    assert.match(r.body.reply_text, /ĐƠN HÀNG #AT-/);

    r = await sendText(server, { zaloUserId, text: "Xác nhận", messageId: "m8" });
    assert.match(r.body.reply_text, /Đã xác nhận đơn hàng #AT-/);

    const customer = platform.repos.customers.findByZaloUserId(zaloUserId);
    const atieuCustomer = platform.atieuCtx.repos.customers.findByZaloUserId(`platform:${customer.id}`);
    const orders = platform.atieuCtx.repos.orders.listByCustomer(atieuCustomer.id, 10);
    assert.equal(orders.length, 1);
    assert.equal(orders[0].status, "CONFIRMED");

    const events = platform.repos.analytics.listByMerchant("ATIEU001", 20);
    assert.ok(events.some((e) => e.event_type === "MERCHANT_VIEW"));
    assert.ok(events.some((e) => e.event_type === "ADD_TO_CART"));
    assert.ok(events.some((e) => e.event_type === "ORDER_CREATED"));
  } finally {
    server.close();
  }
});

test("duplicate platform webhook (same message_id) is idempotent — no double order", async () => {
  const platform = buildTestPlatform();
  const server = await startServer(platform.app);
  const zaloUserId = "wh-dup-1";
  try {
    await sendText(server, { zaloUserId, text: "Xem A Tiểu", messageId: "d1" });
    await sendText(server, { zaloUserId, text: "Cho tôi 1 bò", messageId: "d2" });

    const payload = { zaloUserId, text: "Cho tôi 1 bò", messageId: "d2" }; // same message_id, retried
    const r1 = await sendText(server, payload);
    const r2 = await sendText(server, payload);
    assert.deepEqual(r1.body, r2.body);

    const customer = platform.repos.customers.findByZaloUserId(zaloUserId);
    const atieuCustomer = platform.atieuCtx.repos.customers.findByZaloUserId(`platform:${customer.id}`);
    const { items } = platform.atieuCtx.services.cart.getCart(atieuCustomer.id);
    assert.equal(items.length, 1);
    assert.equal(items[0].quantity, 1); // not doubled by the retried webhook
  } finally {
    server.close();
  }
});

test("non-text webhook events are acked without being processed as chat", async () => {
  const platform = buildTestPlatform();
  const server = await startServer(platform.app);
  try {
    const res = await fetch(`${baseUrl(server)}/platform/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event_name: "follow", sender: { id: "wh-follow-1" } }),
    });
    const body = await res.json();
    assert.equal(body.status, "ignored");
  } finally {
    server.close();
  }
});

test("merchant onboarding + admin review API: PENDING -> not discoverable -> activate -> discoverable", async () => {
  const platform = buildTestPlatform({ withAtieu: false });
  const server = await startServer(platform.app);
  try {
    const createRes = await fetch(`${baseUrl(server)}/api/platform/merchants`, {
      method: "POST",
      headers: { "content-type": "application/json", ...ADMIN_AUTH_HEADER },
      body: JSON.stringify({ merchantId: "QUANF001", name: "Quán F", slug: "quan-f", module: "generic" }),
    });
    assert.equal(createRes.status, 201);

    const searchRes = await fetch(`${baseUrl(server)}/api/platform/search?q=${encodeURIComponent("quán f")}`);
    const searchBody = await searchRes.json();
    assert.equal(searchBody.organic.length, 0); // PENDING, not yet discoverable

    const activateRes = await fetch(`${baseUrl(server)}/api/platform/merchants/QUANF001/status`, {
      method: "PATCH",
      headers: { "content-type": "application/json", ...ADMIN_AUTH_HEADER },
      body: JSON.stringify({ action: "activate" }),
    });
    assert.equal(activateRes.status, 200);

    const getRes = await fetch(`${baseUrl(server)}/api/platform/merchants/QUANF001`, { headers: ADMIN_AUTH_HEADER });
    const getBody = await getRes.json();
    assert.equal(getBody.merchant.status, "TRIAL");
  } finally {
    server.close();
  }
});

test("health and readiness respond", async () => {
  const platform = buildTestPlatform();
  const server = await startServer(platform.app);
  try {
    const health = await fetch(`${baseUrl(server)}/api/platform/health`);
    assert.equal(health.status, 200);
    const ready = await fetch(`${baseUrl(server)}/api/platform/readiness`);
    assert.equal(ready.status, 200);
  } finally {
    server.close();
  }
});
