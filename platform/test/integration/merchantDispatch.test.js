// Generic Merchant Order Dispatch — ChannelMerchantDispatchPort + the
// per-merchant channel config (migration 012) + OrderService's post-commit
// delivery/retry. Telegram is always a fake here: no network call is made.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTestPlatform } from "../helpers/testPlatform.js";
import { FakeMerchantDispatchPort } from "../helpers/fakeMerchantDispatchPort.js";
import { TelegramDispatchChannel } from "../../services/telegramDispatchChannel.js";
import { formatOrderNotification } from "../../services/channelMerchantDispatchPort.js";
import { sendTelegramMessage } from "../../channel/telegram/telegramClient.js";
import { platformConfig } from "../../config.js";

// A fake Telegram transport: records every message; `mode` decides the outcome.
function fakeTelegram(mode = "ok") {
  const fake = {
    mode,
    sent: [],
    send: async ({ chatId, text }) => {
      fake.sent.push({ chatId, text });
      if (fake.mode === "throw") throw new Error("socket hang up");
      return fake.mode === "ok" ? { ok: true } : { ok: false, error: "Forbidden: bot was blocked by the user" };
    },
  };
  return fake;
}

function setup({ mode = "ok", ...opts } = {}) {
  const telegram = fakeTelegram(mode);
  const platform = buildTestPlatform({
    withAtieu: false,
    genericFixtureMerchants: ["MERCHANT002", "MERCHANT003"],
    dispatchChannels: { telegram: new TelegramDispatchChannel({ send: telegram.send }) },
    ...opts,
  });
  return { platform, telegram };
}

let customerSeq = 0;
function makeCustomer(platform) {
  customerSeq += 1;
  return platform.services.customers.getOrCreateByZaloUserId(`dispatch-test-${customerSeq}`, `Khách ${customerSeq}`);
}

function cartWith(platform, customer, merchantId, quantity = 2) {
  const cart = platform.services.cart.createCart(customer.id, merchantId);
  const product = platform.services.menu.listProducts(merchantId)[0];
  platform.services.cart.addItem(customer.id, cart.id, merchantId, product.id, quantity);
  return { cart, product };
}

async function placeOrder(platform, merchantId, customer = makeCustomer(platform)) {
  const { cart } = cartWith(platform, customer, merchantId);
  const order = await platform.services.orders.confirmOrder(customer.id, cart.id);
  return { order, customer, cart };
}

const record = (platform, orderId) => platform.repos.merchantDispatch.getByOrder(orderId);

// --- success ---------------------------------------------------------------------------

test("successful dispatch: the order reaches its merchant's configured chat and advances to SENT_TO_MERCHANT", async () => {
  const { platform, telegram } = setup();
  platform.repos.merchantDispatch.setChannel("MERCHANT002", { channel: "telegram", destination: "1002" });
  const { order } = await placeOrder(platform, "MERCHANT002");

  assert.equal(order.status, "SENT_TO_MERCHANT");
  assert.deepEqual(order.dispatch, { delivered: true, reason: "SENT" });
  assert.equal(telegram.sent.length, 1);
  assert.equal(telegram.sent[0].chatId, "1002");
  const text = telegram.sent[0].text;
  assert.match(text, new RegExp(`#${order.order_code}`));
  assert.match(text, /Merchant 002 \(Test Fixture\)/);
  assert.match(text, /Hủ Tiếu Xào Hải Sản × 2 = 144\.000đ/);
  assert.match(text, /TỔNG: 144\.000đ/);

  const r = record(platform, order.id);
  assert.equal(r.status, "SENT");
  assert.equal(r.attempts, 1);
  assert.equal(r.merchant_id, "MERCHANT002");
  assert.ok(r.sent_at);
});

test("a merchant without a configured (or with a disabled) channel keeps the previous behavior — nothing is sent", async () => {
  const { platform, telegram } = setup();
  const { order } = await placeOrder(platform, "MERCHANT003");
  assert.equal(order.status, "CREATED");
  assert.deepEqual(order.dispatch, { delivered: false, reason: "NO_DISPATCH_CHANNEL" });
  assert.equal(record(platform, order.id), null);

  platform.repos.merchantDispatch.setChannel("MERCHANT003", { channel: "telegram", destination: "1003", enabled: false });
  const second = (await placeOrder(platform, "MERCHANT003")).order;
  assert.equal(second.status, "CREATED");
  assert.equal(second.dispatch.reason, "NO_DISPATCH_CHANNEL");
  assert.equal(telegram.sent.length, 0);
});

// --- failure -------------------------------------------------------------------------------

test("dispatch failure: the order stays created, queryable and its cart retired; the failure is recorded", async () => {
  const { platform, telegram } = setup({ mode: "fail" });
  platform.repos.merchantDispatch.setChannel("MERCHANT002", { channel: "telegram", destination: "1002" });
  const { order, customer, cart } = await placeOrder(platform, "MERCHANT002");

  assert.equal(order.status, "CREATED");
  assert.deepEqual(order.dispatch, { delivered: false, reason: "DISPATCH_FAILED" });
  assert.equal(telegram.sent.length, 1);
  // the order is intact and readable by its customer and by the merchant side
  const read = platform.services.orders.getOrder(customer.id, order.id);
  assert.equal(read.total, 144000);
  assert.deepEqual(read.items.map((i) => [i.product_name, i.quantity]), [["Hủ Tiếu Xào Hải Sản", 2]]);
  assert.equal(platform.services.orders.listOrders(customer.id).length, 1);
  assert.equal(platform.db.prepare(`SELECT status FROM merchant_carts WHERE id = ?`).get(cart.id).status, "CONVERTED");
  const r = record(platform, order.id);
  assert.equal(r.status, "FAILED");
  assert.match(r.last_error, /blocked/);
});

test("dispatch failure: a channel that throws, and a port that throws, never fail the confirmed order", async () => {
  const { platform } = setup({ mode: "throw" });
  platform.repos.merchantDispatch.setChannel("MERCHANT002", { channel: "telegram", destination: "1002" });
  const { order } = await placeOrder(platform, "MERCHANT002");
  assert.equal(order.status, "CREATED");
  assert.equal(order.dispatch.reason, "DISPATCH_FAILED");
  assert.match(record(platform, order.id).last_error, /socket hang up/);

  const broken = buildTestPlatform({
    withAtieu: false,
    genericFixtureMerchants: ["MERCHANT002"],
    dispatchPort: new FakeMerchantDispatchPort({ failWith: new Error("port exploded") }),
  });
  const customer = makeCustomer(broken);
  const { cart } = cartWith(broken, customer, "MERCHANT002");
  const kept = await broken.services.orders.confirmOrder(customer.id, cart.id);
  assert.equal(kept.status, "CREATED");
  assert.deepEqual(kept.dispatch, { delivered: false, reason: "DISPATCH_ERROR" });
  assert.equal(broken.services.orders.getOrder(customer.id, kept.id).id, kept.id);
});

test("an invalid destination is refused without any send", async () => {
  const { platform, telegram } = setup();
  platform.repos.merchantDispatch.setChannel("MERCHANT002", { channel: "telegram", destination: "not a chat id" });
  const { order } = await placeOrder(platform, "MERCHANT002");
  assert.equal(order.status, "CREATED");
  assert.equal(record(platform, order.id).last_error, "INVALID_TELEGRAM_DESTINATION");
  assert.equal(telegram.sent.length, 0);
});

// --- idempotent retry ------------------------------------------------------------------------

test("idempotent retry: a failed delivery is retried once it can succeed, and is never sent twice", async () => {
  const { platform, telegram } = setup({ mode: "fail" });
  platform.repos.merchantDispatch.setChannel("MERCHANT002", { channel: "telegram", destination: "1002" });
  const { order } = await placeOrder(platform, "MERCHANT002");
  assert.equal(order.status, "CREATED");

  telegram.mode = "ok";
  const retried = await platform.services.orders.retryFailedDispatches();
  assert.deepEqual(retried.map((r) => [r.orderId, r.delivered, r.reason]), [[order.id, true, "SENT"]]);
  assert.equal(platform.repos.orders.getById(order.id).status, "SENT_TO_MERCHANT");
  assert.equal(telegram.sent.length, 2); // 1 failed + 1 delivered
  assert.equal(record(platform, order.id).attempts, 2);

  // every further retry path is a no-op
  assert.deepEqual(await platform.services.orders.retryFailedDispatches(), []);
  assert.equal((await platform.services.orders.redispatch(order.id)).dispatch.reason, "NOT_PENDING");
  assert.deepEqual(await platform.services.orders.dispatchPort.dispatch(order), { delivered: true, reason: "ALREADY_SENT" });
  assert.equal(telegram.sent.length, 2);
});

test("idempotent retry: a delivery recorded SENT but not yet reflected on the order is completed without re-sending", async () => {
  const { platform, telegram } = setup();
  platform.repos.merchantDispatch.setChannel("MERCHANT002", { channel: "telegram", destination: "1002" });
  const { order } = await placeOrder(platform, "MERCHANT002");
  // simulate a crash between "sent" and "order updated"
  platform.repos.orders.setStatus(order.id, "CREATED");
  const again = await platform.services.orders.redispatch(order.id);
  assert.equal(again.status, "SENT_TO_MERCHANT");
  assert.equal(again.dispatch.reason, "ALREADY_SENT");
  assert.equal(telegram.sent.length, 1);
});

test("idempotent retry: an attempt in flight is not duplicated; a stale one may be taken over", async () => {
  const { platform, telegram } = setup({ mode: "fail" });
  platform.repos.merchantDispatch.setChannel("MERCHANT002", { channel: "telegram", destination: "1002" });
  const { order } = await placeOrder(platform, "MERCHANT002");
  const r = record(platform, order.id);
  telegram.mode = "ok";

  platform.db.prepare(`UPDATE order_dispatches SET status = 'SENDING', updated_at = datetime('now') WHERE id = ?`).run(r.id);
  assert.equal((await platform.services.orders.redispatch(order.id)).dispatch.reason, "DISPATCH_IN_PROGRESS");
  assert.equal(telegram.sent.length, 1);
  assert.deepEqual(await platform.services.orders.retryFailedDispatches(), []);

  platform.db.prepare(`UPDATE order_dispatches SET updated_at = datetime('now', '-10 minutes') WHERE id = ?`).run(r.id);
  assert.equal((await platform.services.orders.retryFailedDispatches())[0].reason, "SENT");
  assert.equal(telegram.sent.length, 2);
});

test("retry job: respects the attempt cap and never touches cancelled orders", async () => {
  const { platform, telegram } = setup({ mode: "fail" });
  platform.repos.merchantDispatch.setChannel("MERCHANT002", { channel: "telegram", destination: "1002" });
  const capped = (await placeOrder(platform, "MERCHANT002")).order;
  const { order: cancelled, customer } = await placeOrder(platform, "MERCHANT002");
  platform.services.orders.cancelOrder(customer.id, cancelled.id);

  const results = await platform.services.orders.retryFailedDispatches({ maxAttempts: 3 });
  assert.deepEqual(results.map((r) => r.orderId), [capped.id]);
  await platform.services.orders.retryFailedDispatches({ maxAttempts: 3 });
  assert.deepEqual(await platform.services.orders.retryFailedDispatches({ maxAttempts: 3 }), []);
  assert.equal(record(platform, capped.id).attempts, 3);
  assert.equal(record(platform, cancelled.id).attempts, 1);
  assert.equal(platform.repos.orders.getById(cancelled.id).status, "CANCELLED");
  assert.equal(telegram.sent.length, 4); // 2 at confirmation + 2 retries of the capped order
});

// --- merchant isolation -------------------------------------------------------------------------

test("merchant isolation: each order goes only to its own merchant's destination, with only its own items", async () => {
  const { platform, telegram } = setup();
  platform.repos.merchantDispatch.setChannel("MERCHANT002", { channel: "telegram", destination: "1002" });
  platform.repos.merchantDispatch.setChannel("MERCHANT003", { channel: "telegram", destination: "1003" });
  const o2 = (await placeOrder(platform, "MERCHANT002")).order;
  const o3 = (await placeOrder(platform, "MERCHANT003")).order;

  assert.deepEqual(telegram.sent.map((m) => m.chatId), ["1002", "1003"]);
  assert.match(telegram.sent[0].text, /Merchant 002/);
  assert.doesNotMatch(telegram.sent[0].text, /Merchant 003|Hủ Tiếu Xào Bò/);
  assert.match(telegram.sent[1].text, /Merchant 003/);
  assert.doesNotMatch(telegram.sent[1].text, /Merchant 002|Hải Sản/);
  assert.equal(record(platform, o2.id).destination, "1002");
  assert.equal(record(platform, o3.id).destination, "1003");

  // another merchant's config change never reaches this merchant's orders
  platform.repos.merchantDispatch.setChannel("MERCHANT003", { channel: "telegram", destination: "9999" });
  await placeOrder(platform, "MERCHANT002");
  assert.equal(telegram.sent[2].chatId, "1002");
  // a destination never appears in what the customer is told
  assert.ok(!JSON.stringify(o2.dispatch).includes("1002"));
});

// --- message + channel ------------------------------------------------------------------------------

test("the notification carries the checkout details of that order only", () => {
  const text = formatOrderNotification({
    merchant: { name: "Quán Mẫu" },
    order: { order_code: "TD-20260925-001", total: 150000 },
    items: [{ product_name: "Món A", quantity: 2, line_total: 150000 }],
    checkout: { fulfillment_type: "delivery", delivery_address: "76 Nguyễn Thị Minh Khai", customer_phone: "0912345678", note: "không hành" },
    customer: { display_name: "Lan" },
  });
  assert.match(text, /#TD-20260925-001/);
  assert.match(text, /Món A × 2 = 150\.000đ/);
  assert.match(text, /📍 Địa chỉ: 76 Nguyễn Thị Minh Khai/);
  assert.match(text, /☎️ SĐT: 0912345678/);
  assert.match(text, /📝 Ghi chú: không hành/);
  assert.match(text, /Hình thức: Giao hàng/);
});

test("the Telegram channel reuses the platform Telegram client (bot token from config, chat id from the merchant)", async () => {
  const original = platformConfig.telegramBotToken;
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return { ok: true, json: async () => ({ ok: true }) };
  };
  const channel = new TelegramDispatchChannel({ send: (msg) => sendTelegramMessage(msg, { fetchImpl }) });
  try {
    platformConfig.telegramBotToken = "";
    assert.deepEqual(await channel.deliver({ destination: "1002", text: "x" }), { ok: false, error: "PLATFORM_TELEGRAM_BOT_TOKEN not configured" });
    platformConfig.telegramBotToken = "test-bot-token";
    assert.deepEqual(await channel.deliver({ destination: "-1001234", text: "hello" }), { ok: true });
    assert.match(calls[0].url, /\/bottest-bot-token\/sendMessage$/);
    assert.deepEqual(calls[0].body, { chat_id: "-1001234", text: "hello" });
    assert.equal((await channel.deliver({ destination: "abc", text: "x" })).error, "INVALID_TELEGRAM_DESTINATION");
    assert.equal(calls.length, 1);
  } finally {
    platformConfig.telegramBotToken = original;
  }
});
