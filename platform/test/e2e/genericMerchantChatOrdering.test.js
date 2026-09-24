// Chat ordering for generic (data-driven) merchants: search → select →
// menu → cart → order, entirely through the existing generic MenuService,
// CartService and OrderService. A Tiểu keeps its own engine. The extra
// products below are test-only, created in the in-memory test database.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTestPlatform, startServer, baseUrl } from "../helpers/testPlatform.js";
import { platformConfig } from "../../config.js";
import { config as atieuConfig } from "../../../src/config.js";

let seq = 0;

function addTestProducts(platform) {
  const menu = platform.services.menu;
  menu.createProduct("MERCHANT002", { sku: "T2-CAPHE-SUA", name: "Cà Phê Sữa Đá", price: 25000, available: true, keywords: ["ca phe sua", "cafe sua"] });
  const bacXiu = menu.createProduct("MERCHANT002", { sku: "T2-BACXIU", name: "Bạc Xỉu", price: 30000, available: true, keywords: ["bac xiu"] });
  menu.setProductAvailability("MERCHANT002", bacXiu.id, false);
  menu.createProduct("MERCHANT003", { sku: "T3-CAPHE-DEN", name: "Cà Phê Đen", price: 20000, available: true, keywords: ["ca phe den", "cafe den"] });
}

async function withPlatform(fn) {
  const platform = buildTestPlatform({ withAtieu: true, genericFixtureMerchants: ["MERCHANT002", "MERCHANT003"] });
  addTestProducts(platform);
  const server = await startServer(platform.app);
  const say = async (userId, text) => {
    const res = await fetch(`${baseUrl(server)}${platformConfig.webhookPath}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event_name: "user_send_text", sender: { id: userId }, message: { text, msg_id: `gco-${++seq}` }, timestamp: Date.now() }),
    });
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.status, "processed", JSON.stringify(body));
    return body.reply_text;
  };
  const customerId = (userId) => platform.repos.customers.findByZaloUserId(userId).id;
  const activeCart = (userId, merchantId) => {
    const cart = platform.db.prepare("SELECT * FROM merchant_carts WHERE customer_id = ? AND merchant_id = ? AND status = 'ACTIVE'").get(customerId(userId), merchantId);
    if (!cart) return [];
    return platform.db.prepare("SELECT product_name, quantity, unit_price FROM merchant_cart_items WHERE cart_id = ? ORDER BY id").all(cart.id).map((i) => [i.product_name, i.quantity]);
  };
  const orders = (userId) =>
    platform.db.prepare("SELECT * FROM orders WHERE customer_id = ? ORDER BY id").all(customerId(userId)).map((o) => ({
      ...o,
      items: platform.db.prepare("SELECT product_name, quantity, unit_price FROM order_items WHERE order_id = ? ORDER BY id").all(o.id).map((i) => [i.product_name, i.quantity, i.unit_price]),
    }));
  // Search, then pick the given merchant by its number in the results.
  const openMerchant = async (userId, query, merchantName) => {
    const reply = await say(userId, query);
    const rows = [...reply.matchAll(/^\[(\d+)\] (.+)$/gm)];
    const row = rows.find((m) => m[2] === merchantName.toUpperCase());
    assert.ok(row, `${merchantName} not listed for "${query}":\n${reply}`);
    const opened = await say(userId, row[1]);
    assert.match(opened, new RegExp(`^Đã mở ${merchantName.replace(/[()]/g, "\\$&")}`));
    return opened;
  };
  try {
    return await fn({ platform, say, customerId, activeCart, orders, openMerchant });
  } finally {
    server.close();
  }
}

const M2 = "Merchant 002 (Test Fixture)";
const M3 = "Merchant 003 (Test Fixture)";

test("menu: 'xem menu' and 'cho tôi xem menu' show the selected merchant's available dishes with prices", async () => {
  await withPlatform(async ({ say, openMerchant }) => {
    await openMerchant("gco-menu", "tìm quán cà phê", M2);
    for (const text of ["xem menu", "cho tôi xem menu", "thực đơn"]) {
      const reply = await say("gco-menu", text);
      assert.match(reply, /Cà Phê Sữa Đá: 25\.000đ/, text);
      assert.match(reply, /Hủ Tiếu Xào Hải Sản: 72\.000đ/, text);
      assert.doesNotMatch(reply, /Bạc Xỉu/, text); // unavailable
      assert.doesNotMatch(reply, /Cà Phê Đen|Hủ Tiếu Xào Bò/, text); // another merchant's dishes
      assert.doesNotMatch(reply, /chỉ hỗ trợ xem menu/, text);
    }
  });
});

test("cart: add with a quantity, add more of the same dish, and view the cart", async () => {
  await withPlatform(async ({ say, activeCart, openMerchant }) => {
    await openMerchant("gco-cart", "tìm quán cà phê", M2);
    let reply = await say("gco-cart", "cho tôi 2 cà phê sữa đá");
    assert.match(reply, /Cà Phê Sữa Đá × 2/);
    assert.deepEqual(activeCart("gco-cart", "MERCHANT002"), [["Cà Phê Sữa Đá", 2]]);

    reply = await say("gco-cart", "thêm 1 cà phê sữa đá");
    assert.match(reply, /Cà Phê Sữa Đá × 3/);
    reply = await say("gco-cart", "thêm hai hủ tiếu xào hải sản");
    assert.deepEqual(activeCart("gco-cart", "MERCHANT002"), [["Cà Phê Sữa Đá", 3], ["Hủ Tiếu Xào Hải Sản", 2]]);

    reply = await say("gco-cart", "xem giỏ hàng");
    assert.match(reply, /Cà Phê Sữa Đá × 3 = 75\.000đ/);
    assert.match(reply, /Hủ Tiếu Xào Hải Sản × 2 = 144\.000đ/);
    assert.match(reply, /Tạm tính: 219\.000đ/);
  });
});

test("a dish name containing a number word is not read as a quantity", async () => {
  await withPlatform(async ({ say, activeCart, openMerchant }) => {
    await openMerchant("gco-haisan", "tìm quán cà phê", M2);
    await say("gco-haisan", "thêm hủ tiếu xào hải sản"); // "hải" folds to "hai" (two)
    assert.deepEqual(activeCart("gco-haisan", "MERCHANT002"), [["Hủ Tiếu Xào Hải Sản", 1]]);
  });
});

test("order: 'đặt hàng' turns the cart into a persisted order for that merchant and customer", async () => {
  await withPlatform(async ({ platform, say, customerId, activeCart, orders, openMerchant }) => {
    await openMerchant("gco-order", "tìm quán cà phê", M2);
    await say("gco-order", "cho tôi 2 cà phê sữa đá");
    await say("gco-order", "thêm 1 hủ tiếu xào hải sản");
    const reply = await say("gco-order", "đặt hàng");

    const placed = orders("gco-order");
    assert.equal(placed.length, 1);
    const order = placed[0];
    assert.equal(order.merchant_id, "MERCHANT002");
    assert.equal(order.customer_id, customerId("gco-order"));
    assert.deepEqual(order.items, [["Cà Phê Sữa Đá", 2, 25000], ["Hủ Tiếu Xào Hải Sản", 1, 72000]]);
    assert.equal(order.total, 122000);
    assert.equal(order.status, "CREATED"); // no dispatch channel: never claimed as delivered
    assert.match(reply, new RegExp(`#${order.order_code}`));
    assert.match(reply, /122\.000đ/);
    assert.match(reply, /chờ quán/);
    assert.doesNotMatch(reply, /quán đã nhận/i);
    assert.deepEqual(activeCart("gco-order", "MERCHANT002"), []); // cart retired with the order

    const events = platform.db.prepare("SELECT merchant_id, event_type, external_ref FROM merchant_events WHERE customer_id = ? ORDER BY id").all(customerId("gco-order"));
    assert.ok(events.some((e) => e.event_type === "ADD_TO_CART" && e.merchant_id === "MERCHANT002"));
    assert.ok(events.some((e) => e.event_type === "ORDER_CREATED" && e.merchant_id === "MERCHANT002" && e.external_ref === order.order_code));
  });
});

test("a repeated 'đặt hàng' does not create a second order", async () => {
  await withPlatform(async ({ say, orders, openMerchant }) => {
    await openMerchant("gco-dup", "tìm quán cà phê", M2);
    await say("gco-dup", "cho tôi 1 cà phê sữa đá");
    await say("gco-dup", "đặt hàng");
    const again = await say("gco-dup", "đặt hàng");
    assert.match(again, /Giỏ hàng đang trống/);
    assert.equal(orders("gco-dup").length, 1);
  });
});

test("'đặt hàng' with an empty cart creates no order", async () => {
  await withPlatform(async ({ say, orders, openMerchant }) => {
    await openMerchant("gco-empty", "tìm quán cà phê", M2);
    assert.match(await say("gco-empty", "đặt hàng"), /Giỏ hàng đang trống/);
    assert.match(await say("gco-empty", "xem giỏ hàng"), /Giỏ hàng đang trống/);
    assert.equal(orders("gco-empty").length, 0);
  });
});

test("a dish the merchant does not sell is refused and nothing is created", async () => {
  await withPlatform(async ({ platform, say, activeCart, openMerchant }) => {
    await openMerchant("gco-missing", "tìm quán cà phê", M2);
    const productsBefore = platform.db.prepare("SELECT COUNT(*) AS n FROM merchant_products").get().n;
    for (const text of ["cho tôi 2 phở", "thêm 1 hủ tiếu xá xíu", "cho tôi 1 cà phê đen"]) {
      const reply = await say("gco-missing", text);
      assert.match(reply, /không có món/, text);
      assert.doesNotMatch(reply, /Đã thêm/, text);
    }
    assert.deepEqual(activeCart("gco-missing", "MERCHANT002"), []);
    assert.equal(platform.db.prepare("SELECT COUNT(*) AS n FROM merchant_products").get().n, productsBefore);
  });
});

test("an unavailable dish is reported as such and not added", async () => {
  await withPlatform(async ({ say, activeCart, openMerchant }) => {
    await openMerchant("gco-unavail", "tìm quán cà phê", M2);
    const reply = await say("gco-unavail", "cho tôi 1 bạc xỉu");
    assert.match(reply, /Bạc Xỉu/);
    assert.match(reply, /tạm hết/);
    assert.deepEqual(activeCart("gco-unavail", "MERCHANT002"), []);
  });
});

test("invalid quantities are refused and the cart is unchanged", async () => {
  await withPlatform(async ({ say, activeCart, openMerchant }) => {
    await openMerchant("gco-qty", "tìm quán cà phê", M2);
    await say("gco-qty", "cho tôi 1 cà phê sữa đá");
    for (const text of ["cho tôi 0 cà phê sữa đá", "cho tôi 999 cà phê sữa đá", "thêm 50 cà phê sữa đá"]) {
      const reply = await say("gco-qty", text);
      assert.match(reply, /Số lượng không hợp lệ/, text);
    }
    assert.deepEqual(activeCart("gco-qty", "MERCHANT002"), [["Cà Phê Sữa Đá", 1]]);
  });
});

test("an ambiguous or missing dish name asks instead of guessing", async () => {
  await withPlatform(async ({ platform, say, activeCart, openMerchant }) => {
    platform.services.menu.createProduct("MERCHANT002", { sku: "T2-CAPHE-DA", name: "Cà Phê Đá", price: 22000, available: true, keywords: [] });
    await openMerchant("gco-ambig", "tìm quán cà phê", M2);
    let reply = await say("gco-ambig", "cho tôi 1 cà phê");
    assert.match(reply, /Cà Phê Sữa Đá/);
    assert.match(reply, /Cà Phê Đá/);
    assert.doesNotMatch(reply, /Đã thêm/);
    reply = await say("gco-ambig", "thêm 2 món này");
    assert.match(reply, /món nào/);
    assert.deepEqual(activeCart("gco-ambig", "MERCHANT002"), []);
  });
});

test("'xóa giỏ hàng' empties the cart", async () => {
  await withPlatform(async ({ say, activeCart, openMerchant }) => {
    await openMerchant("gco-clear", "tìm quán cà phê", M2);
    await say("gco-clear", "cho tôi 2 cà phê sữa đá");
    assert.match(await say("gco-clear", "xóa giỏ hàng"), /Đã xóa/);
    assert.deepEqual(activeCart("gco-clear", "MERCHANT002"), []);
  });
});

test("switching merchants never mixes carts: each order holds only its own merchant's dishes", async () => {
  await withPlatform(async ({ say, activeCart, orders, openMerchant }) => {
    await openMerchant("gco-switch", "tìm quán cà phê", M2);
    await say("gco-switch", "cho tôi 2 cà phê sữa đá");
    await say("gco-switch", "quay lại tổng đài");

    await openMerchant("gco-switch", "tìm quán cà phê", M3);
    const foreign = await say("gco-switch", "cho tôi 1 cà phê sữa đá"); // Merchant 002's dish
    assert.match(foreign, /không có món/);
    await say("gco-switch", "cho tôi 1 cà phê đen");
    await say("gco-switch", "đặt hàng");

    let placed = orders("gco-switch");
    assert.equal(placed.length, 1);
    assert.equal(placed[0].merchant_id, "MERCHANT003");
    assert.deepEqual(placed[0].items, [["Cà Phê Đen", 1, 20000]]);
    assert.deepEqual(activeCart("gco-switch", "MERCHANT002"), [["Cà Phê Sữa Đá", 2]]); // still there, untouched

    await say("gco-switch", "quay lại tổng đài");
    await openMerchant("gco-switch", "tìm quán cà phê", M2);
    assert.match(await say("gco-switch", "xem giỏ hàng"), /Cà Phê Sữa Đá × 2/);
    await say("gco-switch", "đặt hàng");
    placed = orders("gco-switch");
    assert.equal(placed.length, 2);
    assert.equal(placed[1].merchant_id, "MERCHANT002");
    assert.deepEqual(placed[1].items, [["Cà Phê Sữa Đá", 2, 25000]]);
  });
});

test("two customers in the same merchant keep separate carts and orders", async () => {
  await withPlatform(async ({ say, activeCart, orders, openMerchant }) => {
    await openMerchant("gco-a", "tìm quán cà phê", M2);
    await openMerchant("gco-b", "tìm quán cà phê", M2);
    await say("gco-a", "cho tôi 2 cà phê sữa đá");
    await say("gco-b", "cho tôi 1 hủ tiếu xào hải sản");
    assert.deepEqual(activeCart("gco-a", "MERCHANT002"), [["Cà Phê Sữa Đá", 2]]);
    assert.deepEqual(activeCart("gco-b", "MERCHANT002"), [["Hủ Tiếu Xào Hải Sản", 1]]);
    assert.doesNotMatch(await say("gco-b", "xem giỏ hàng"), /Cà Phê/);

    await say("gco-a", "đặt hàng");
    assert.equal(orders("gco-a").length, 1);
    assert.equal(orders("gco-b").length, 0);
    assert.deepEqual(activeCart("gco-b", "MERCHANT002"), [["Hủ Tiếu Xào Hải Sản", 1]]);
    await say("gco-b", "đặt hàng");
    assert.deepEqual(orders("gco-b")[0].items, [["Hủ Tiếu Xào Hải Sản", 1, 72000]]);
    assert.deepEqual(orders("gco-a")[0].items, [["Cà Phê Sữa Đá", 2, 25000]]);
  });
});

test("a merchant that becomes unavailable mid-conversation takes no more cart or order actions", async () => {
  await withPlatform(async ({ platform, say, orders, openMerchant }) => {
    await openMerchant("gco-susp", "tìm quán cà phê", M2);
    await say("gco-susp", "cho tôi 1 cà phê sữa đá");
    platform.services.merchants.suspend("MERCHANT002");
    platform.registry.invalidate("MERCHANT002");
    assert.match(await say("gco-susp", "đặt hàng"), /không khả dụng/);
    assert.equal(orders("gco-susp").length, 0);
  });
});

test("typed text never reaches SQL or picks a product by id", async () => {
  await withPlatform(async ({ say, activeCart, openMerchant }) => {
    await openMerchant("gco-inject", "tìm quán cà phê", M2);
    for (const text of ["cho tôi 2 %' OR 1=1 --", "thêm 1 product_id=1", "cho tôi 1 merchant_id=MERCHANT003", "cho tôi 2 _", "thêm 1 %"]) {
      const reply = await say("gco-inject", text);
      assert.doesNotMatch(reply, /Đã thêm/, text);
    }
    assert.deepEqual(activeCart("gco-inject", "MERCHANT002"), []);
  });
});

test("A Tiểu still uses its own engine: its cart never touches the generic cart tables", async () => {
  await withPlatform(async ({ platform, say, customerId, openMerchant }) => {
    await openMerchant("gco-atieu", "tìm cho tôi hủ tiếu", "Hủ Tiếu Xào A Tiểu");
    const reply = await say("gco-atieu", "Cho tôi 2 hủ tiếu xào bò");
    assert.match(reply, /Đã thêm: Hủ Tiếu Xào Bò × 2/);
    assert.equal(platform.db.prepare("SELECT COUNT(*) AS n FROM merchant_carts WHERE merchant_id = 'ATIEU001'").get().n, 0);
    const atieuCustomer = platform.atieuCtx.repos.customers.findByZaloUserId(`platform:${customerId("gco-atieu")}`);
    const { items } = platform.atieuCtx.services.cart.getCart(atieuCustomer.id);
    assert.deepEqual(items.map((i) => i.quantity), [2]);
  });
});

test("Telegram group: search → pick by number → menu → cart → order with a generic merchant (Bot API intercepted)", async () => {
  const saved = { fetch: globalThis.fetch, token: platformConfig.telegramBotToken, secret: platformConfig.telegramWebhookSecret, atieuToken: atieuConfig.telegramBotToken };
  const botApiCalls = [];
  platformConfig.telegramBotToken = "111111:test-generic-order-bot";
  platformConfig.telegramWebhookSecret = "test-generic-order-secret";
  atieuConfig.telegramBotToken = "";
  globalThis.fetch = async (url, options) => {
    if (String(url).startsWith("https://api.telegram.org/")) {
      botApiCalls.push(JSON.parse(options.body));
      return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return saved.fetch(url, options);
  };
  const platform = buildTestPlatform({ withAtieu: true, genericFixtureMerchants: ["MERCHANT002", "MERCHANT003"] });
  addTestProducts(platform);
  const server = await startServer(platform.app);
  const GROUP = -700456;
  let updateId = 770000;
  const say = async (userId, text) => {
    const res = await saved.fetch(`${baseUrl(server)}${platformConfig.telegramWebhookPath}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": "test-generic-order-secret" },
      body: JSON.stringify({ update_id: ++updateId, message: { message_id: updateId, from: { id: userId, is_bot: false, first_name: "Khách" }, chat: { id: GROUP, type: "group" }, date: 1, text } }),
    });
    const body = await res.json();
    assert.equal(body.status, "processed", JSON.stringify(body));
    return body.reply_text;
  };
  try {
    const results = await say(9201, "tìm quán cà phê");
    const m3 = [...results.matchAll(/^\[(\d+)\] (.+)$/gm)].find((m) => m[2] === M3.toUpperCase());
    assert.match(await say(9201, m3[1]), /^Đã mở Merchant 003/);
    assert.match(await say(9201, "xem menu"), /Cà Phê Đen: 20\.000đ/);
    assert.match(await say(9201, "cho tôi 3 cà phê đen"), /Cà Phê Đen × 3/);
    assert.match(await say(9201, "xem giỏ hàng"), /Tạm tính: 60\.000đ/);
    const placed = await say(9201, "đặt hàng");
    const customer = platform.repos.customers.findByZaloUserId("telegram:9201");
    const order = platform.db.prepare("SELECT * FROM orders WHERE customer_id = ?").get(customer.id);
    assert.equal(order.merchant_id, "MERCHANT003");
    assert.equal(order.total, 60000);
    assert.match(placed, new RegExp(`#${order.order_code}`));
    assert.ok(botApiCalls.length >= 6 && botApiCalls.every((c) => c.chat_id === String(GROUP)));
  } finally {
    server.close();
    globalThis.fetch = saved.fetch;
    platformConfig.telegramBotToken = saved.token;
    platformConfig.telegramWebhookSecret = saved.secret;
    atieuConfig.telegramBotToken = saved.atieuToken;
  }
});
