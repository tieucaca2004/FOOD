import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTestContext } from "../helpers/testApp.js";

function makeCustomer(ctx) {
  return ctx.repos.customers.create({ zaloUserId: `test-${Date.now()}-${Math.random()}`, phone: "0912345678" });
}

async function confirmOneOrder(ctx, customer) {
  const bo = ctx.repos.products.findBySku("HTX-BO");
  ctx.services.cart.addItem(customer.id, bo.id, 1);
  const cartView = ctx.services.cart.getCart(customer.id);
  let order = ctx.services.orders.startCheckout(customer, cartView.cart, cartView.items);
  order = ctx.services.orders.applyCheckoutField(order, "fulfillment_type", "takeaway", 0);
  order = ctx.services.orders.moveToPendingConfirmation(order);
  return ctx.services.orders.confirm(order, cartView.cart);
}

test("without Telegram configured, notification is logged (not faked as sent)", async () => {
  const ctx = buildTestContext();
  // Make "not configured" true regardless of the developer's .env.
  const { config } = await import("../../src/config.js");
  const prevToken = config.telegramBotToken;
  const prevChat = config.telegramChatId;
  config.telegramBotToken = "";
  config.telegramChatId = "";
  try {
    const customer = makeCustomer(ctx);
    const confirmed = await confirmOneOrder(ctx, customer);

    const notifications = ctx.repos.notifications.listByOrder(confirmed.id);
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].status, "skipped_no_channel");
    assert.equal(ctx.sentNotifications.length, 0);
  } finally {
    config.telegramBotToken = prevToken;
    config.telegramChatId = prevChat;
  }
});

test("Telegram failure is recorded as failed, never reported as sent", async () => {
  const failingSend = async () => {
    throw new Error("Telegram unreachable");
  };
  const ctx = buildTestContext({ telegramSend: failingSend });
  // Force the "configured" branch by monkeypatching config via the service's
  // injected sender path: notificationService only calls telegramSend when
  // config has both token+chat id, so we simulate that by temporarily
  // setting them for this test.
  const { config } = await import("../../src/config.js");
  const prevToken = config.telegramBotToken;
  const prevChat = config.telegramChatId;
  config.telegramBotToken = "test-token";
  config.telegramChatId = "test-chat";
  try {
    const customer = makeCustomer(ctx);
    const confirmed = await confirmOneOrder(ctx, customer);
    const notifications = ctx.repos.notifications.listByOrder(confirmed.id);
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].status, "failed");
    assert.match(notifications[0].error, /Telegram unreachable/);
  } finally {
    config.telegramBotToken = prevToken;
    config.telegramChatId = prevChat;
  }
});

test("Telegram success path records status sent and includes order code in payload", async () => {
  let sentPayload = null;
  const okSend = async (args) => {
    sentPayload = args;
  };
  const ctx = buildTestContext({ telegramSend: okSend });
  const { config } = await import("../../src/config.js");
  const prevToken = config.telegramBotToken;
  const prevChat = config.telegramChatId;
  config.telegramBotToken = "test-token";
  config.telegramChatId = "test-chat";
  try {
    const customer = makeCustomer(ctx);
    const confirmed = await confirmOneOrder(ctx, customer);
    const notifications = ctx.repos.notifications.listByOrder(confirmed.id);
    assert.equal(notifications[0].status, "sent");
    assert.ok(sentPayload.text.includes(confirmed.order_code));
  } finally {
    config.telegramBotToken = prevToken;
    config.telegramChatId = prevChat;
  }
});

test("order is never notified before it reaches CONFIRMED", () => {
  const ctx = buildTestContext();
  const customer = makeCustomer(ctx);
  const bo = ctx.repos.products.findBySku("HTX-BO");
  ctx.services.cart.addItem(customer.id, bo.id, 1);
  const cartView = ctx.services.cart.getCart(customer.id);
  const order = ctx.services.orders.startCheckout(customer, cartView.cart, cartView.items);

  const notifications = ctx.repos.notifications.listByOrder(order.id);
  assert.equal(notifications.length, 0);
});
