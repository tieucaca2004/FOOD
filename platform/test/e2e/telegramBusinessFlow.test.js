// Business E2E over the real Telegram webhook route (SIMULATED: updates are
// posted locally; every Bot API call is intercepted, never sent). Telegram is
// only the channel adapter — discovery, merchant routing, menu, cart and order
// all run through the same platform/A Tiểu services the Zalo channel uses.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTestPlatform, startServer, baseUrl } from "../helpers/testPlatform.js";
import { platformConfig } from "../../config.js";
import { config as atieuConfig } from "../../../src/config.js";

const WEBHOOK_SECRET = "test-business-flow-secret";
const PLATFORM_BOT_TOKEN = "111111:test-platform-bot-token";
const ATIEU_BOT_TOKEN = "222222:test-atieu-notification-token";
const ATIEU_CHAT_ID = "test-atieu-owner-chat";

// Both config modules load a developer's .env; never let this file reach the
// real Bot API with either bot's real credentials.
platformConfig.telegramBotToken = "";

function update({ userId, updateId, text }) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      from: { id: userId, is_bot: false, first_name: "Khách" },
      chat: { id: userId, type: "private" },
      date: Math.floor(Date.now() / 1000),
      text,
    },
  };
}

async function withIsolatedTelegram(fn) {
  const saved = {
    fetch: globalThis.fetch,
    platformToken: platformConfig.telegramBotToken,
    secret: platformConfig.telegramWebhookSecret,
    atieuToken: atieuConfig.telegramBotToken,
    atieuChat: atieuConfig.telegramChatId,
  };
  const botApiCalls = [];
  platformConfig.telegramBotToken = PLATFORM_BOT_TOKEN;
  platformConfig.telegramWebhookSecret = WEBHOOK_SECRET;
  atieuConfig.telegramBotToken = ATIEU_BOT_TOKEN;
  atieuConfig.telegramChatId = ATIEU_CHAT_ID;
  globalThis.fetch = async (url, options) => {
    if (String(url).startsWith("https://api.telegram.org/")) {
      botApiCalls.push({ url: String(url), body: JSON.parse(options.body) });
      return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return saved.fetch(url, options);
  };
  try {
    return await fn(botApiCalls);
  } finally {
    globalThis.fetch = saved.fetch;
    platformConfig.telegramBotToken = saved.platformToken;
    platformConfig.telegramWebhookSecret = saved.secret;
    atieuConfig.telegramBotToken = saved.atieuToken;
    atieuConfig.telegramChatId = saved.atieuChat;
  }
}

test("Telegram business E2E: search → A Tiểu → real menu → cart → order confirmation, through the shared services", async () => {
  await withIsolatedTelegram(async (botApiCalls) => {
    const platform = buildTestPlatform({ withAtieu: true });
    const server = await startServer(platform.app);
    const USER = 7001;
    const OTHER_USER = 7002;
    let nextUpdateId = 90000;

    async function say(userId, text) {
      const res = await fetch(`${baseUrl(server)}${platformConfig.telegramWebhookPath}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": WEBHOOK_SECRET },
        body: JSON.stringify(update({ userId, updateId: ++nextUpdateId, text })),
      });
      const body = await res.json();
      assert.equal(res.status, 200, JSON.stringify(body));
      assert.equal(body.status, "processed", JSON.stringify(body));
      assert.equal(body.respond_error, null);
      return body;
    }

    try {
      // 1-2. Discovery through the concierge + AgentSearch, not AI.
      let r = await say(USER, "Tôi muốn ăn hủ tiếu xào");
      assert.match(r.reply_text, /HỦ TIẾU XÀO A TIỂU/);
      const customer = platform.repos.customers.findByZaloUserId(`telegram:${USER}`);
      let session = platform.repos.sessions.getActiveByCustomer(customer.id);
      assert.equal(session.context, "platform");
      assert.deepEqual(session.lastSearchResults.map((m) => m.merchant_id), ["ATIEU001"]);

      // 3-4. Selecting the merchant loads its menu from A Tiểu's menu service.
      r = await say(USER, "Xem A Tiểu");
      assert.match(r.reply_text, /Đã mở/);
      session = platform.repos.sessions.getActiveByCustomer(customer.id);
      assert.equal(session.context, "merchant");
      assert.equal(session.active_merchant_id, "ATIEU001");
      const menu = platform.atieuCtx.services.menu.listMenu();
      assert.ok(menu.length > 0);
      for (const product of menu) assert.ok(r.reply_text.includes(product.name), `menu reply missing ${product.name}`);

      // 5-6. A real product goes into the cart.
      const product = menu.find((p) => p.sku === "HTX-BO");
      r = await say(USER, "Cho tôi 2 hủ tiếu xào bò");
      assert.match(r.reply_text, /× 2/);

      // 7. Cart persistence, keyed to this Telegram customer's bridged A Tiểu identity.
      const atieuCustomer = platform.atieuCtx.repos.customers.findByZaloUserId(`platform:${customer.id}`);
      let { items } = platform.atieuCtx.services.cart.getCart(atieuCustomer.id);
      assert.deepEqual(
        items.map((i) => ({ productId: i.product_id, quantity: i.quantity })),
        [{ productId: product.id, quantity: 2 }]
      );

      // Isolation: a second Telegram user builds a separate cart.
      await say(OTHER_USER, "Tôi muốn ăn hủ tiếu xào");
      await say(OTHER_USER, "Xem A Tiểu");
      await say(OTHER_USER, "Cho tôi 1 hủ tiếu xào hải sản");
      const otherCustomer = platform.repos.customers.findByZaloUserId(`telegram:${OTHER_USER}`);
      const otherAtieuCustomer = platform.atieuCtx.repos.customers.findByZaloUserId(`platform:${otherCustomer.id}`);
      assert.notEqual(otherCustomer.id, customer.id);
      assert.notEqual(otherAtieuCustomer.id, atieuCustomer.id);
      ({ items } = platform.atieuCtx.services.cart.getCart(atieuCustomer.id));
      assert.deepEqual(items.map((i) => [i.product_id, i.quantity]), [[product.id, 2]]);
      const otherItems = platform.atieuCtx.services.cart.getCart(otherAtieuCustomer.id).items;
      assert.deepEqual(otherItems.map((i) => [i.product_id, i.quantity]), [[menu.find((p) => p.sku === "HTX-HAISAN").id, 1]]);

      // 8. Existing order flow through A Tiểu's order service.
      await say(USER, "Đặt");
      await say(USER, "Mang về");
      r = await say(USER, "0912345678");
      assert.match(r.reply_text, /ĐƠN HÀNG #AT-/);
      r = await say(USER, "Xác nhận");
      assert.match(r.reply_text, /Đã xác nhận đơn hàng #AT-/);

      const orders = platform.atieuCtx.repos.orders.listByCustomer(atieuCustomer.id, 10);
      assert.equal(orders.length, 1);
      assert.equal(orders[0].status, "CONFIRMED");
      const orderDetail = platform.atieuCtx.services.orders.getDetail(orders[0].id);
      assert.deepEqual(orderDetail.items.map((i) => [i.product_name, i.quantity, i.line_total]), [[product.name, 2, product.price * 2]]);
      assert.equal(platform.atieuCtx.repos.orders.listByCustomer(otherAtieuCustomer.id, 10).length, 0);

      // Funnel analytics: the same shared recorder the Zalo channel uses.
      const events = platform.db
        .prepare("SELECT merchant_id, event_type, external_ref FROM merchant_events WHERE customer_id = ? ORDER BY id")
        .all(customer.id);
      const types = events.map((e) => e.event_type);
      for (const expected of ["SEARCH", "MERCHANT_VIEW", "ADD_TO_CART", "CHECKOUT_STARTED", "ORDER_CREATED"]) {
        assert.ok(types.includes(expected), `missing ${expected}: ${types.join(",")}`);
      }
      assert.deepEqual(events.find((e) => e.event_type === "SEARCH"), { merchant_id: null, event_type: "SEARCH", external_ref: null });
      assert.ok(events.filter((e) => e.event_type !== "SEARCH").every((e) => e.merchant_id === "ATIEU001"));
      assert.equal(events.find((e) => e.event_type === "ORDER_CREATED").external_ref, orders[0].order_code);
      const searches = platform.db.prepare("SELECT query_text, result_count FROM search_events WHERE customer_id = ?").all(customer.id);
      assert.deepEqual(searches, [{ query_text: "hủ tiếu xào", result_count: 1 }]);

      // 9. Platform-side persistence: one customer, one session, every message logged.
      assert.equal(platform.db.prepare("SELECT COUNT(*) AS n FROM platform_sessions WHERE customer_id = ?").get(customer.id).n, 1);
      const logged = platform.db
        .prepare("SELECT m.direction, COUNT(*) AS n FROM platform_messages m JOIN platform_sessions s ON s.id = m.session_id WHERE s.customer_id = ? GROUP BY m.direction")
        .all(customer.id);
      assert.deepEqual(Object.fromEntries(logged.map((row) => [row.direction, row.n])), { in: 7, out: 7 });

      // Telegram replies: every processed update answered in the originating
      // chat with the platform bot; the order notification went through A
      // Tiểu's own notifier (the test context's fake sender), never the
      // customer-facing bot.
      assert.ok(botApiCalls.every((c) => c.url.includes(PLATFORM_BOT_TOKEN)));
      assert.equal(botApiCalls.filter((c) => c.body.chat_id === String(USER)).length, 7);
      assert.equal(botApiCalls.filter((c) => c.body.chat_id === String(OTHER_USER)).length, 3);
      const ownerNotifications = platform.atieuCtx.sentNotifications;
      assert.equal(ownerNotifications.length, 1);
      assert.equal(ownerNotifications[0].botToken, ATIEU_BOT_TOKEN);
      assert.equal(ownerNotifications[0].chatId, ATIEU_CHAT_ID);
      assert.match(ownerNotifications[0].text, new RegExp(`#${orders[0].order_code}`));
    } finally {
      server.close();
    }
  });
});

test("Telegram /start (plain or bot-addressed) gets the platform greeting, not a failed food search", async () => {
  await withIsolatedTelegram(async (botApiCalls) => {
    const platform = buildTestPlatform({ withAtieu: true });
    const server = await startServer(platform.app);
    try {
      let updateId = 95000;
      for (const text of ["/start", "/start@ChefBotAI_bot"]) {
        const res = await fetch(`${baseUrl(server)}${platformConfig.telegramWebhookPath}`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": WEBHOOK_SECRET },
          body: JSON.stringify(update({ userId: 7101, updateId: ++updateId, text })),
        });
        const body = await res.json();
        assert.equal(body.status, "processed");
        assert.match(body.reply_text, /em là trợ lý của TỔNG ĐÀI/);
        assert.doesNotMatch(body.reply_text, /chưa tìm thấy quán nào/);
        assert.doesNotMatch(body.reply_text, /Zalo/);
      }
      assert.equal(botApiCalls.length, 2);

      // A normal food search is unaffected.
      const search = await fetch(`${baseUrl(server)}${platformConfig.telegramWebhookPath}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": WEBHOOK_SECRET },
        body: JSON.stringify(update({ userId: 7101, updateId: 95100, text: "Tôi muốn ăn hủ tiếu xào" })),
      });
      assert.match((await search.json()).reply_text, /HỦ TIẾU XÀO A TIỂU/);
    } finally {
      server.close();
    }
  });
});

test("a funnel-analytics failure does not break the Telegram conversation", async () => {
  await withIsolatedTelegram(async (botApiCalls) => {
    const platform = buildTestPlatform({ withAtieu: true });
    const server = await startServer(platform.app);
    platform.repos.analytics.logSearch = () => {
      throw new Error("SQLITE_BUSY: database is locked");
    };
    try {
      const res = await fetch(`${baseUrl(server)}${platformConfig.telegramWebhookPath}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": WEBHOOK_SECRET },
        body: JSON.stringify(update({ userId: 7201, updateId: 96001, text: "Tôi muốn ăn hủ tiếu xào" })),
      });
      const body = await res.json();
      assert.equal(res.status, 200);
      assert.equal(body.status, "processed");
      assert.match(body.reply_text, /HỦ TIẾU XÀO A TIỂU/);
      assert.equal(botApiCalls.length, 1);
    } finally {
      server.close();
    }
  });
});
