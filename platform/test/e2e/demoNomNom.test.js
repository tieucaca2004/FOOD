// [DEMO] Nôm Nôm Restaurant — opt-in demo merchant on the generic engine.
// Seeds via the real platform/db/demoSeed.js (source of truth:
// platform/db/demo/nomnom_demo_source_snapshot.json) into an in-memory DB,
// then drives the customer flow through the real Telegram webhook HTTP path
// (SIMULATED updates — no real Bot API call: the bot token is blanked).
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTestPlatform, startServer, baseUrl } from "../helpers/testPlatform.js";
import { platformConfig } from "../../config.js";
import { loadNomNomSnapshot, runNomNomDemoSeed, NOMNOM_DEMO_MERCHANT_ID as DEMO_ID } from "../../db/demoSeed.js";
import { GenericMerchantAdapter } from "../../merchant/adapters/GenericMerchantAdapter.js";
import { parseItemRequest, parseQuantityChange, matchByName, resolveItemRequest } from "../../nlp/genericOrderText.js";

platformConfig.telegramBotToken = ""; // never send real Bot API messages from tests

const TEST_SECRET = "test-telegram-secret-value";
const SNAPSHOT = loadNomNomSnapshot();
const PRODUCTS = SNAPSHOT.products;

function vnd(n) {
  return `${Number(n).toLocaleString("vi-VN")}đ`;
}

async function withChat(fn) {
  const originalSecret = platformConfig.telegramWebhookSecret;
  platformConfig.telegramWebhookSecret = TEST_SECRET;
  const platform = buildTestPlatform({ withAtieu: true, withNomNomDemo: true });
  const server = await startServer(platform.app);
  let updateId = 0;
  const say = async (text, userId = 4242) => {
    updateId += 1;
    const res = await fetch(`${baseUrl(server)}${platformConfig.telegramWebhookPath}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": TEST_SECRET },
      body: JSON.stringify({
        update_id: updateId,
        message: {
          message_id: updateId,
          from: { id: userId, is_bot: false, first_name: "Demo" },
          chat: { id: userId, type: "private" },
          date: Math.floor(Date.now() / 1000),
          text,
        },
      }),
    });
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.status, "processed");
    return body.reply_text;
  };
  const customerId = (userId) => platform.repos.customers.findByZaloUserId(`telegram:${userId}`).id;
  try {
    await fn({ platform, say, customerId });
  } finally {
    server.close();
    platformConfig.telegramWebhookSecret = originalSecret;
  }
}

const count = (db, sql, ...args) => db.prepare(sql).get(...args).n;
const demoOrderCount = (platform) => count(platform.db, `SELECT COUNT(*) AS n FROM orders WHERE merchant_id = ?`, DEMO_ID);

// --- SEED ---------------------------------------------------------------------

test("SEED: snapshot is the source of truth — 47 products, 3.714.000 VND, no invented fields", () => {
  assert.equal(PRODUCTS.length, 47);
  assert.equal(PRODUCTS.reduce((s, p) => s + p.price_vnd, 0), 3714000);
  for (const p of PRODUCTS) {
    assert.equal(p.description, null);
    assert.equal(p.category, null);
    assert.equal(p.unit, null);
    assert.equal(p.price_off, null);
  }
  assert.notEqual(DEMO_ID, "ATIEU001");
});

test("SEED: creates the generic DEMO merchant with 47/47 products, name + price_vnd verbatim", () => {
  const { db, services } = buildTestPlatform({ withAtieu: false, withNomNomDemo: true });

  const merchant = services.merchantData.getById(DEMO_ID);
  assert.equal(merchant.name, "[DEMO] Nôm Nôm Restaurant");
  assert.equal(merchant.module, "generic");
  assert.equal(merchant.account_status, "ACTIVE");
  assert.equal(merchant.active, 1);
  assert.ok(services.merchantData.isDiscoverable(merchant));
  assert.equal(merchant.address, "73/16 Đường Trần Quang Khải, Phường Lộc Thọ, Thành phố Nha Trang, Khánh Hòa");
  assert.equal(merchant.latitude, 12.2396);
  assert.equal(merchant.longitude, 109.1978);
  assert.equal(merchant.phone, null); // third-party contact data, excluded by the snapshot
  assert.equal(merchant.description, null); // marketplace blurb is not a restaurant description
  assert.equal(merchant.opening_hours_json, null); // free text only — never parsed into a schedule

  const settings = Object.fromEntries(
    db.prepare(`SELECT key, value FROM merchant_settings WHERE merchant_id = ?`).all(DEMO_ID).map((r) => [r.key, r.value])
  );
  assert.equal(settings.is_demo, "true");
  assert.equal(settings.environment, "non-production");
  assert.equal(settings.open_hours_text, "9.am- 9.pm daily");
  assert.equal(settings.source_shop_id, "61a7e997-aed6-4e99-a14b-2c4a1442a773");

  assert.equal(services.menu.getMenuStatus(DEMO_ID), "PUBLISHED");
  const products = services.menu.listProducts(DEMO_ID);
  assert.equal(products.length, 47);
  assert.deepEqual(
    products.map((p) => [p.name, p.price]),
    PRODUCTS.map((p) => [p.name, p.price_vnd])
  );
  assert.equal(products.reduce((s, p) => s + p.price, 0), 3714000);
  for (const p of products) {
    assert.equal(p.category_id, null);
    assert.equal(p.description, null);
  }
});

// --- IDEMPOTENCY ------------------------------------------------------------------

test("IDEMPOTENCY: a second run creates no duplicate merchant, menu, products or subscription", () => {
  const { db } = buildTestPlatform({ withAtieu: false, withNomNomDemo: true });
  runNomNomDemoSeed(db);
  assert.equal(count(db, `SELECT COUNT(*) AS n FROM merchants WHERE merchant_id = ?`, DEMO_ID), 1);
  assert.equal(count(db, `SELECT COUNT(*) AS n FROM merchants WHERE name LIKE '%Nôm Nôm%'`), 1);
  assert.equal(count(db, `SELECT COUNT(*) AS n FROM merchant_menus WHERE merchant_id = ?`, DEMO_ID), 1);
  assert.equal(count(db, `SELECT COUNT(*) AS n FROM merchant_products WHERE merchant_id = ?`, DEMO_ID), 47);
  assert.equal(count(db, `SELECT COUNT(*) AS n FROM merchant_subscriptions WHERE merchant_id = ?`, DEMO_ID), 1);
});

test("IDEMPOTENCY: rows seeded under the earlier SKU scheme are re-keyed by name, not duplicated", () => {
  const { db, services } = buildTestPlatform({ withAtieu: false, withNomNomDemo: true });
  db.prepare(`UPDATE merchant_products SET sku = 'NN-legacy-' || id WHERE merchant_id = ?`).run(DEMO_ID);
  const idsBefore = services.menu.listProducts(DEMO_ID).map((p) => p.id);
  runNomNomDemoSeed(db);
  assert.equal(count(db, `SELECT COUNT(*) AS n FROM merchant_products WHERE merchant_id = ?`, DEMO_ID), 47);
  assert.deepEqual(services.menu.listProducts(DEMO_ID).map((p) => p.id), idsBefore);
});

// --- SEARCH --------------------------------------------------------------------

test("SEARCH: all five phrases find the demo merchant; 'Tìm hủ tiếu xào' still finds A Tiểu", async () => {
  await withChat(async ({ say }) => {
    let userId = 100;
    for (const phrase of ["Tìm Nôm Nôm", "Tìm quán Nôm Nôm", "Nôm Nôm Restaurant", "Tìm pizza", "Tìm hủ tiếu xào"]) {
      userId += 1;
      const reply = await say(phrase, userId);
      assert.match(reply, /\[DEMO\] NÔM NÔM RESTAURANT/, `"${phrase}" -> ${reply}`);
      if (phrase === "Tìm hủ tiếu xào") assert.match(reply, /HỦ TIẾU XÀO A TIỂU/, `A Tiểu missing for "${phrase}"`);
    }
    // Unaccented shop name also works; nonsense still finds nothing.
    assert.match(await say("nom nom restaurant", 150), /\[DEMO\] NÔM NÔM RESTAURANT/);
    assert.match(await say("Tìm xyzxyz", 151), /chưa tìm thấy quán/);
  });
});

// --- SELECT / MENU / CART / ORDER (spec Phase 6 steps 1-10) ------------------------

test("ORDER FLOW: find, select, menu, add '3 cheeses Pizza' + 'Greek Salad', view cart, increase qty, re-check, order", async () => {
  await withChat(async ({ platform, say, customerId }) => {
    // 1. SEARCH
    let reply = await say("Tìm Nôm Nôm");
    assert.match(reply, /\[DEMO\] NÔM NÔM RESTAURANT/);

    // 2-3. SELECT + MENU
    reply = await say("Xem quán Nôm Nôm");
    assert.match(reply, /Đã mở \[DEMO\] Nôm Nôm Restaurant/);
    for (const p of PRODUCTS) assert.ok(reply.includes(`${p.name}: ${vnd(p.price_vnd)}`), `menu missing ${p.name}`);

    // 4. "3 cheeses Pizza" — the leading 3 belongs to the dish name, it is NOT a quantity
    reply = await say("Thêm 3 cheeses Pizza");
    assert.match(reply, /Đã thêm 1 × 3 cheeses Pizza - Phô Mai 3 Kiểu 28cm \(100\.000đ\)/);

    // 5. second item
    reply = await say("Thêm Greek Salad");
    assert.match(reply, /Đã thêm 1 × Greek Salad - Salad Hy Lạp \(65\.000đ\)/);

    // 6. view cart
    reply = await say("Xem giỏ");
    assert.match(reply, /1 × 3 cheeses Pizza - Phô Mai 3 Kiểu 28cm = 100\.000đ/);
    assert.match(reply, /1 × Greek Salad - Salad Hy Lạp = 65\.000đ/);
    assert.match(reply, /Tạm tính: 165\.000đ/);

    // 7. increase quantity
    reply = await say("Tăng Greek Salad lên 2");
    assert.match(reply, /Đã đổi Greek Salad - Salad Hy Lạp thành 2/);

    // 8. re-check cart
    reply = await say("Xem giỏ");
    assert.match(reply, /2 × Greek Salad - Salad Hy Lạp = 130\.000đ/);
    assert.match(reply, /Tạm tính: 230\.000đ/);

    // 9. "Đặt hàng" shows the final summary; "Xác nhận" places it
    reply = await say("Đặt hàng");
    assert.match(reply, /kiểm tra lại đơn/);
    assert.match(reply, /Tạm tính: 230\.000đ/);
    assert.equal(demoOrderCount(platform), 0);
    reply = await say("Xác nhận");
    assert.match(reply, /✅ Đã tạo đơn TD-\d{8}-\d+/);
    assert.match(reply, /Tổng: 230\.000đ/);
    assert.match(reply, /CHƯA được gửi tới quán/);

    // 10. the order: demo merchant, this customer, never dispatched
    const orders = platform.services.orders.listOrders(customerId(4242));
    assert.equal(orders.length, 1);
    const order = platform.services.orders.getOrder(customerId(4242), orders[0].id);
    assert.equal(order.merchant_id, DEMO_ID);
    assert.notEqual(order.merchant_id, "ATIEU001");
    assert.equal(order.status, "CREATED"); // NullMerchantDispatchPort — nothing leaves the system
    assert.equal(order.total, 230000);
    assert.deepEqual(
      order.items.map((i) => [i.product_name, i.unit_price, i.quantity]),
      [
        ["3 cheeses Pizza - Phô Mai 3 Kiểu 28cm", 100000, 1],
        ["Greek Salad - Salad Hy Lạp", 65000, 2],
      ]
    );
    assert.equal(count(platform.db, `SELECT COUNT(*) AS n FROM orders WHERE merchant_id = 'ATIEU001'`), 0);
  });
});

test("ORDER safety: a bare 'xác nhận' never orders without a summary; a cart changed after it needs a fresh one", async () => {
  await withChat(async ({ platform, say }) => {
    await say("Xem quán Nôm Nôm");
    await say("Thêm 1 Greek Salad");
    assert.match(await say("Xác nhận"), /kiểm tra lại đơn/);
    assert.equal(demoOrderCount(platform), 0);

    await say("Thêm 1 Garlic Bread");
    const reply = await say("Ok");
    assert.match(reply, /kiểm tra lại đơn/);
    assert.match(reply, /Garlic Bread/);
    assert.equal(demoOrderCount(platform), 0);

    assert.match(await say("Chốt đơn"), /Tổng: 100\.000đ/);
    assert.equal(demoOrderCount(platform), 1);
  });
});

test("CART: ambiguous or unknown dish names are never guessed", async () => {
  await withChat(async ({ platform, say }) => {
    await say("Xem quán Nôm Nôm");
    assert.match(await say("Thêm pizza"), /món phù hợp/);
    const tie = await say("Thêm 1 Pizza Thập Cẩm Thịt 28cm"); // two source dishes share this text
    assert.match(tie, /món phù hợp/);
    assert.match(tie, /Meatlover Pizza/);
    assert.match(await say("Thêm 1 phở bò"), /không tìm thấy món/);
    assert.match(await say("Xem giỏ"), /Giỏ hàng đang trống/);
    assert.equal(demoOrderCount(platform), 0);
  });
});

// --- ISOLATION ------------------------------------------------------------------

test("ISOLATION: customer A and B never see each other's cart or order", async () => {
  await withChat(async ({ platform, say, customerId }) => {
    const A = 7001;
    const B = 7002;
    await say("Xem quán Nôm Nôm", A);
    await say("Xem quán Nôm Nôm", B);
    await say("Thêm 1 Greek Salad", A);
    await say("Thêm 2 Garlic Bread", B);

    const cartA = await say("Xem giỏ", A);
    assert.match(cartA, /Greek Salad/);
    assert.doesNotMatch(cartA, /Garlic Bread/);
    const cartB = await say("Xem giỏ", B);
    assert.match(cartB, /Garlic Bread/);
    assert.doesNotMatch(cartB, /Greek Salad/);

    await say("Đặt hàng", A);
    await say("Xác nhận", A);
    await say("Đặt hàng", B);
    await say("Xác nhận", B);

    const { cart, orders } = platform.services;
    const idA = customerId(A);
    const idB = customerId(B);
    const ordersA = orders.listOrders(idA);
    const ordersB = orders.listOrders(idB);
    assert.equal(ordersA.length, 1);
    assert.equal(ordersB.length, 1);
    assert.equal(ordersA[0].total, 65000);
    assert.equal(ordersB[0].total, 70000);

    assert.throws(() => orders.getOrder(idA, ordersB[0].id), { code: "ORDER_NOT_OWNED" });
    assert.throws(() => orders.getOrder(idB, ordersA[0].id), { code: "ORDER_NOT_OWNED" });

    await say("Thêm 1 Greek Salad", B);
    const openCartB = cart.getOrCreateCart(idB, DEMO_ID);
    assert.throws(() => cart.getCart(idA, openCartB.id), { code: "CART_NOT_OWNED" });
    assert.throws(() => cart.addItem(idA, openCartB.id, DEMO_ID, openCartB.items[0].product_id, 1), { code: "CART_NOT_OWNED" });
  });
});

test("ISOLATION: the demo merchant doesn't touch A Tiểu, and A Tiểu never gets generic cart items", async () => {
  await withChat(async ({ platform, say, customerId }) => {
    const atieuDb = platform.atieuCtx.db;
    await say("Xem quán Nôm Nôm");
    await say("Thêm 1 Greek Salad");
    await say("Đặt hàng");
    await say("Xác nhận");
    assert.equal(count(atieuDb, `SELECT COUNT(*) AS n FROM cart_items`), 0);
    assert.equal(count(atieuDb, `SELECT COUNT(*) AS n FROM orders`), 0);

    // A Tiểu still works through its own frozen engine in the same session.
    assert.match(await say("Quay lại tổng đài"), /Đã quay lại Tổng Đài/);
    assert.match(await say("Tìm hủ tiếu xào"), /HỦ TIẾU XÀO A TIỂU/);
    assert.match(await say("Xem A Tiểu"), /Đã mở/);
    assert.match(await say("Cho tôi 2 hủ tiếu xào bò"), /× 2/);
    assert.ok(count(atieuDb, `SELECT COUNT(*) AS n FROM cart_items`) > 0);
    // ...and nothing of A Tiểu's lands in the generic cart/order tables.
    assert.equal(count(platform.db, `SELECT COUNT(*) AS n FROM merchant_carts WHERE merchant_id = 'ATIEU001'`), 0);
    assert.equal(count(platform.db, `SELECT COUNT(*) AS n FROM orders WHERE merchant_id = 'ATIEU001'`), 0);

    // A generic cart can't be pointed at A Tiểu with a demo product either.
    const idC = customerId(4242);
    const demoProduct = platform.services.menu.listProducts(DEMO_ID)[0];
    const atieuCart = platform.services.cart.getOrCreateCart(idC, "ATIEU001");
    assert.throws(() => platform.services.cart.addItem(idC, atieuCart.id, "ATIEU001", demoProduct.id, 1), { code: "PRODUCT_NOT_FOUND" });
    assert.equal(count(platform.db, `SELECT COUNT(*) AS n FROM merchant_cart_items WHERE cart_id = ?`, atieuCart.id), 0);
  });
});

// --- Parsing units ------------------------------------------------------------

test("parsing: quantity is only a leading/trailing token; 'Nấm' is not 5; a number starting a dish name stays in it", () => {
  const items = PRODUCTS.map((p) => ({ id: p.position, name: p.name, price: p.price_vnd }));
  assert.deepEqual(parseItemRequest("thêm Capricciosa Pizza - Jambon Nấm Trứng 28cm").quantity, null);
  assert.deepEqual(parseItemRequest("cho tôi hai gỏi cuốn nha"), { quantity: 2, query: "goi cuon" });
  assert.deepEqual(parseItemRequest("lấy coca x3"), { quantity: 3, query: "coca" });

  let r = resolveItemRequest("thêm 3 cheeses Pizza", items);
  assert.equal(r.quantity, null);
  assert.equal(r.match.name, "3 cheeses Pizza - Phô Mai 3 Kiểu 28cm");
  r = resolveItemRequest("thêm 2 phần 3 cheeses Pizza", items);
  assert.equal(r.quantity, 2);
  assert.equal(r.match.name, "3 cheeses Pizza - Phô Mai 3 Kiểu 28cm");
  r = resolveItemRequest("thêm 2 seafood pizza", items);
  assert.equal(r.quantity, 2);
  assert.equal(r.match.name, "Seafood Pizza - Pizza Hải Sản 28cm");

  assert.deepEqual(parseQuantityChange("đổi pizza hải sản thành 3 phần"), { query: "pizza hai san", quantity: 3 });
  assert.deepEqual(parseQuantityChange("tăng greek salad lên 2"), { query: "greek salad", quantity: 2 });
  assert.equal(parseQuantityChange("xem giỏ"), null);
  assert.equal(parseQuantityChange("thêm 1 Lemon Juice - Nước Đá Chanh"), null);
});

test("matchByName requires every query word, narrows to an exact name, and reports ties", () => {
  const items = PRODUCTS.map((p) => ({ id: p.position, name: p.name }));
  assert.equal(matchByName("coca", items).match.name, "COCA COLA 320ML");
  assert.equal(matchByName("cocacola", items).match.name, "COCA COLA 320ML");
  assert.equal(matchByName("mi y tom toi", items).match.name, "Mì Ý Tôm tỏi");
  assert.equal(matchByName("pizza thap cam thit 28cm", items).match, null);
  assert.equal(matchByName("pizza thap cam thit 28cm", items).candidates.length, 2);
  assert.equal(matchByName("sushi", items).candidates.length, 0);
});

test("without cart/order services the generic adapter keeps its original menu-only reply", async () => {
  const { services } = buildTestPlatform({ withAtieu: false, withNomNomDemo: true });
  const adapter = new GenericMerchantAdapter({ merchantId: DEMO_ID, menuService: services.menu, merchantDataService: services.merchantData });
  const { replyText } = await adapter.handleMessage(1, "thêm 1 coca");
  assert.match(replyText, /chỉ hỗ trợ xem menu/);
});
