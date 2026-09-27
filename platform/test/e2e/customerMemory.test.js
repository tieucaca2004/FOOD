// Customer Memory — full conversations over the real Telegram webhook path
// (SIMULATED updates; the bot token is blanked). Memory proposes; only the
// customer's confirmation creates an order.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTestPlatform, startServer, baseUrl } from "../helpers/testPlatform.js";
import { platformConfig } from "../../config.js";

platformConfig.telegramBotToken = "";

const TEST_SECRET = "test-telegram-secret-value";
const NOMNOM = "DEMO_NOMNOM001";
const SEAFOOD = "Seafood Pizza - Pizza Hải Sản 28cm";
const ADDRESS = "76 Nguyễn Thị Minh Khai";

async function withChat(fn) {
  const originalSecret = platformConfig.telegramWebhookSecret;
  platformConfig.telegramWebhookSecret = TEST_SECRET;
  const platform = buildTestPlatform({ withAtieu: true, withNomNomDemo: true });
  const server = await startServer(platform.app);
  let seq = 0;
  const say = async (text, userId = 9800) => {
    seq += 1;
    const res = await fetch(`${baseUrl(server)}${platformConfig.telegramWebhookPath}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": TEST_SECRET },
      body: JSON.stringify({
        update_id: seq,
        message: { message_id: seq, from: { id: userId, is_bot: false, first_name: "M" }, chat: { id: userId, type: "private" }, date: 1, text },
      }),
    });
    const body = await res.json();
    assert.equal(body.status, "processed", JSON.stringify(body));
    return body.reply_text;
  };
  const cid = (userId = 9800) => platform.repos.customers.findByZaloUserId(`telegram:${userId}`).id;
  const orders = (merchantId = NOMNOM) => platform.db.prepare(`SELECT * FROM orders WHERE merchant_id = ? ORDER BY id`).all(merchantId);
  const orderNote = (order) => platform.repos.cartCheckout.getByCart(order.cart_id)?.note ?? null;
  const pref = (userId, attribute) => platform.db.prepare(`SELECT * FROM customer_preferences WHERE customer_id = ? AND attribute = ?`).get(cid(userId), attribute) || null;
  try {
    await fn({ platform, say, cid, orders, orderNote, pref });
  } finally {
    server.close();
    platformConfig.telegramWebhookSecret = originalSecret;
  }
}

async function firstNomNomOrder(say, userId) {
  await say("Xem quán Nôm Nôm", userId);
  await say("Cho 2 pizza hải sản", userId);
  assert.match(await say("Không hành, ít tiêu nhé", userId), /Dạ em ghi chú cho đơn này: không hành, ít tiêu\./);
  await say("giao qua 76 Nguyễn Thị Minh Khai", userId);
  const summary = await say("Đặt hàng", userId);
  assert.match(summary, /📍 Giao tới: 76 Nguyễn Thị Minh Khai[\s\S]*📝 Ghi chú: không hành, ít tiêu/);
  assert.match(await say("Xác nhận", userId), /✅ Đã tạo đơn/);
}

// --- the spec flow, generic engine -----------------------------------------------------------

test("FULL FLOW (generic): first order with preferences + address, then 'Cho anh như cũ.' proposes it and orders only after 'Ừ'", async () => {
  await withChat(async ({ say, orders, orderNote, pref }) => {
    await firstNomNomOrder(say);
    assert.equal(orders().length, 1);
    assert.equal(orderNote(orders()[0]), "không hành, ít tiêu");
    // one order = evidence, not yet a habit
    assert.equal(pref(9800, "onion").status, "CANDIDATE");

    await say("Quay lại tổng đài");
    await say("Xem quán Nôm Nôm");
    const proposal = await say("Cho anh như cũ.");
    assert.match(proposal, /Dạ, đơn lần trước của anh\/chị ở \[DEMO\] Nôm Nôm Restaurant:/);
    assert.match(proposal, /2 × Seafood Pizza - Pizza Hải Sản 28cm — 100\.000đ = 200\.000đ/);
    assert.match(proposal, /📝 không hành, ít tiêu/);
    assert.match(proposal, /📍 Giao tới: 76 Nguyễn Thị Minh Khai/);
    assert.match(proposal, /xác nhận đặt đơn này/);
    assert.equal(orders().length, 1); // nothing created by the proposal

    const placed = await say("Ừ");
    assert.match(placed, /✅ Đã tạo đơn/);
    assert.match(placed, /2 × Seafood Pizza/);
    assert.equal(orders().length, 2);
    assert.equal(orderNote(orders()[1]), "không hành, ít tiêu");
  });
});

test("'như cũ' with no history never invents one", async () => {
  await withChat(async ({ say, orders }) => {
    await say("Xem quán Nôm Nôm");
    assert.match(await say("cho như lần trước"), /chưa thấy đơn nào trước đây/);
    assert.match(await say("Không"), /./);
    assert.equal(orders().length, 0);
  });
});

test("'như cũ nhưng hôm nay nhiều tiêu': today's instruction wins for this order only", async () => {
  await withChat(async ({ say, orders, orderNote, pref }) => {
    await firstNomNomOrder(say);
    const proposal = await say("như cũ nhưng hôm nay nhiều tiêu");
    assert.match(proposal, /📝 không hành, nhiều tiêu/);
    await say("đúng");
    assert.equal(orderNote(orders()[1]), "không hành, nhiều tiêu");
    // the habit evidence is untouched by a "hôm nay" override
    assert.equal(pref(9800, "pepper").value, "low");
  });
});

test("current menu always wins: new price is used; an unavailable dish is reported, never substituted", async () => {
  await withChat(async ({ platform, say, orders }) => {
    await firstNomNomOrder(say);
    const seafood = platform.services.menu.listProducts(NOMNOM, { includeUnavailable: true }).find((p) => p.name === SEAFOOD);
    platform.services.menu.updateProduct(NOMNOM, seafood.id, { price: 120000 });
    assert.match(await say("như cũ"), /2 × Seafood Pizza - Pizza Hải Sản 28cm — 120\.000đ = 240\.000đ/);
    await say("không");
    platform.services.menu.setProductAvailability(NOMNOM, seafood.id, false);
    const reply = await say("như cũ");
    assert.match(reply, /Seafood Pizza - Pizza Hải Sản 28cm hiện không còn trong menu — em không tự thay bằng món khác/);
    assert.match(reply, /muốn chọn món khác/);
    assert.match(await say("ừ"), /./); // nothing pending: no order from this "ừ"
    assert.equal(orders().length, 1);
  });
});

test("'như mọi lần' prefers the recurring combination over the latest one-off", async () => {
  await withChat(async ({ say }) => {
    for (let i = 0; i < 2; i++) {
      await say("Xem quán Nôm Nôm");
      await say("Cho 1 Greek Salad");
      await say("Đặt hàng");
      await say("Lấy tại quán");
      await say("Xác nhận");
    }
    await say("Cho 3 coca");
    await say("Đặt hàng");
    await say("Lấy tại quán");
    await say("Xác nhận");
    assert.match(await say("như cũ"), /3 × COCA COLA 320ML/);
    await say("không");
    const usual = await say("cho như mọi lần");
    assert.match(usual, /đơn anh\/chị hay đặt/);
    assert.match(usual, /1 × Greek Salad - Salad Hy Lạp/);
    assert.match(usual, /🏪 Nhận tại quán/);
  });
});

// --- preferences --------------------------------------------------------------------------

test("persistent preference: 'Em không ăn hành' is applied (and shown) on the next orders at this merchant only", async () => {
  await withChat(async ({ platform, say, orders, orderNote, pref }) => {
    await say("Xem quán Nôm Nôm");
    assert.match(await say("Em không ăn hành"), /Em cũng nhớ cho những lần sau ở quán này/);
    assert.deepEqual([pref(9800, "onion").status, pref(9800, "onion").confidence], ["ACTIVE", 0.95]);
    await say("Cho 1 coca");
    await say("Lấy tại quán");
    await say("Đặt hàng");
    await say("Xác nhận");
    assert.equal(orderNote(orders()[0]), "không hành"); // said in this conversation
    // the NEXT order gets it from memory — and says so
    await say("Cho 1 coca");
    await say("Lấy tại quán");
    const summary = await say("Đặt hàng");
    assert.match(summary, /🧠 Theo sở thích anh\/chị đã dặn: không hành/);
    await say("Xác nhận");
    assert.equal(orderNote(orders()[1]), "không hành");

    // another merchant: a merchant-scoped preference does not follow the customer there
    platform.repos.merchants.create({ merchantId: "MEMFIXTURE01", name: "Quán Nhớ Thử (Test Fixture)", slug: "quan-nho-thu", module: "generic", status: "ACTIVE", address: "1 Đường Thử" });
    platform.db.prepare(`INSERT INTO merchant_subscriptions (merchant_id, plan_id, status, started_at) VALUES ('MEMFIXTURE01','free','ACTIVE',datetime('now'))`).run();
    platform.repos.merchantProducts.create("MEMFIXTURE01", { sku: "B1", name: "Bún Thử", price: 30000, available: true });
    await say("Quay lại tổng đài");
    await say("Xem quán Nhớ Thử");
    await say("Cho 1 bún thử");
    await say("Lấy tại quán");
    assert.doesNotMatch(await say("Đặt hàng"), /không hành/);

    // a GLOBAL statement does follow
    await say("Em không ăn đậu phộng ở đâu cũng vậy");
    assert.match(await say("Đặt hàng"), /không đậu phộng/);
  });
});

test("temporary 'Hôm nay đừng cho hành' applies to this order only and is never remembered", async () => {
  await withChat(async ({ say, orders, orderNote, pref }) => {
    await say("Xem quán Nôm Nôm");
    await say("Cho 1 coca");
    assert.match(await say("Hôm nay đừng cho hành"), /Chỉ áp dụng cho đơn này/);
    await say("Lấy tại quán");
    await say("Đặt hàng");
    await say("Xác nhận");
    assert.equal(orderNote(orders()[0]), "không hành");
    assert.equal(pref(9800, "onion"), null);
  });
});

test("contradiction: 'Hôm nay cho hành' overrides for today only; 'Thật ra em ăn hành bình thường' changes the preference", async () => {
  await withChat(async ({ say, orders, orderNote, pref }) => {
    await say("Xem quán Nôm Nôm");
    await say("Em không ăn hành");
    await say("Cho 1 coca");
    assert.match(await say("Hôm nay cho hành"), /lần sau em vẫn nhớ: không hành/);
    await say("Lấy tại quán");
    await say("Đặt hàng");
    await say("Xác nhận");
    assert.equal(orderNote(orders()[0]), "hành bình thường");
    assert.equal(pref(9800, "onion").value, "avoid"); // kept
    await say("Thật ra em ăn hành bình thường");
    assert.deepEqual([pref(9800, "onion").value, pref(9800, "onion").contradiction_count], ["normal", 1]);
  });
});

test("customer correction 'Không, em muốn ít tiêu' is a strong signal", async () => {
  await withChat(async ({ say, pref }) => {
    await say("Xem quán Nôm Nôm");
    await say("Cho 1 coca");
    await say("không tiêu");
    await say("Không, em muốn ít tiêu");
    const p = pref(9800, "pepper");
    assert.deepEqual([p.value, p.source, p.confidence, p.status], ["low", "customer_correction", 0.9, "ACTIVE"]);
  });
});

test("repeated confirmed orders turn an instruction into an applied habit; a single order never does", async () => {
  await withChat(async ({ say, pref }) => {
    for (let i = 0; i < 3; i++) {
      await say("Xem quán Nôm Nôm");
      await say("Cho 1 coca");
      await say("không hành");
      await say("Lấy tại quán");
      await say("Đặt hàng");
      await say("Xác nhận");
      if (i === 0) assert.equal(pref(9800, "onion").status, "CANDIDATE");
    }
    assert.equal(pref(9800, "onion").status, "ACTIVE");
    await say("Cho 1 coca");
    await say("Lấy tại quán");
    assert.match(await say("Đặt hàng"), /🧠 Theo sở thích anh\/chị đã dặn: không hành/);
  });
});

// --- addresses ----------------------------------------------------------------------------------

test("'giao chỗ cũ': one address -> used; several -> asked (numbered), never guessed; labels resolve", async () => {
  await withChat(async ({ say }) => {
    await firstNomNomOrder(say);
    await say("Cho 1 coca");
    assert.match(await say("giao chỗ cũ"), /📍 Giao tới: 76 Nguyễn Thị Minh Khai/);
    await say("Địa chỉ công ty là 123 Trần Phú");
    const ask = await say("giao địa chỉ cũ");
    assert.match(ask, /có 2 địa chỉ đã dùng/);
    const list = ask.split("\n").filter((l) => /^\d+\. /.test(l));
    const idx = list.findIndex((l) => l.includes("123 Trần Phú"));
    assert.match(await say(String(idx + 1)), /📍 Giao tới: 123 Trần Phú/);
    assert.match(await say("giao về công ty"), /📍 Giao tới: 123 Trần Phú/);
    assert.match(await say("giao về nhà"), /chưa lưu địa chỉ "nhà"/);
  });
});

test("a saved address is offered at checkout, not assumed", async () => {
  await withChat(async ({ say, orders }) => {
    await firstNomNomOrder(say);
    await say("Cho 1 coca");
    const offer = await say("Đặt hàng");
    assert.match(offer, /giao tới 76 Nguyễn Thị Minh Khai như lần trước không/);
    assert.equal(orders().length, 1);
    assert.match(await say("đúng"), /📍 Giao tới: 76 Nguyễn Thị Minh Khai[\s\S]*xác nhận đặt đơn này/);
  });
});

// --- isolation ------------------------------------------------------------------------------------

test("customer isolation: B never sees A's order, preferences or address", async () => {
  await withChat(async ({ say }) => {
    await firstNomNomOrder(say, 1);
    await say("Em không ăn hành", 1);
    await say("Xem quán Nôm Nôm", 2);
    assert.match(await say("như cũ", 2), /chưa thấy đơn nào/);
    await say("Cho 1 coca", 2);
    const summary = await say("Đặt hàng", 2);
    assert.doesNotMatch(summary, /Minh Khai|không hành/);
    assert.match(await say("giao chỗ cũ", 2), /chưa lưu địa chỉ cũ/);
  });
});

// --- A Tiểu (module with its own engine) ----------------------------------------------------------

test("FULL FLOW (A Tiểu): first order with preferences, then 'Cho anh như cũ.' — A Tiểu's own summary (with its delivery fee) is confirmed before the order", async () => {
  await withChat(async ({ platform, say, cid }) => {
    await say("Tìm hủ tiếu xào");
    await say("Xem A Tiểu");
    await say("Cho tôi 2 hủ tiếu thập cẩm");
    assert.match(await say("Không hành, ít tiêu nhé"), /📝 Ghi chú: không hành, ít tiêu/);
    assert.match(await say("Giao 76 Nguyễn Thị Minh Khai"), /📍 Giao tới: 76 Nguyễn Thị Minh Khai/);
    assert.match(await say("Đặt"), /số điện thoại/);
    assert.match(await say("0912345678"), /ĐƠN HÀNG #AT-/);
    assert.match(await say("Xác nhận"), /Đã xác nhận đơn hàng #AT-/);
    const refs = platform.repos.customerMemory.listOrderRefs(cid(), "ATIEU001");
    assert.equal(refs.length, 1);
    assert.deepEqual(refs[0].instructions.map((i) => i.label), ["không hành", "ít tiêu"]);

    const proposal = await say("Cho anh như cũ.");
    assert.match(proposal, /Dạ, đơn lần trước của anh\/chị ở Hủ Tiếu Xào A Tiểu:/);
    assert.match(proposal, /2 × Hủ Tiếu Xào Thập Cẩm — 60\.000đ = 120\.000đ/);
    assert.match(proposal, /📝 không hành, ít tiêu/);
    assert.match(proposal, /📍 Giao tới: 76 Nguyễn Thị Minh Khai/);
    const ordersBefore = platform.atieuCtx.db.prepare(`SELECT COUNT(*) AS n FROM orders WHERE status = 'CONFIRMED'`).get().n;

    // A Tiểu adds a 15.000đ delivery fee the proposal could not show -> its own summary is confirmed
    const summary = await say("Ừ");
    assert.match(summary, /ĐƠN HÀNG #AT-/);
    assert.match(summary, /Phí giao hàng|15\.000đ/);
    assert.equal(platform.atieuCtx.db.prepare(`SELECT COUNT(*) AS n FROM orders WHERE status = 'CONFIRMED'`).get().n, ordersBefore);
    assert.match(await say("Xác nhận"), /Đã xác nhận đơn hàng #AT-/);
    const second = platform.atieuCtx.db.prepare(`SELECT * FROM orders ORDER BY id DESC LIMIT 1`).get();
    assert.deepEqual([second.status, second.delivery_address, second.fulfillment_type], ["CONFIRMED", ADDRESS, "delivery"]);
    const items = platform.atieuCtx.db.prepare(`SELECT product_name, quantity, unit_price FROM order_items WHERE order_id = ?`).all(second.id);
    assert.deepEqual(items, [{ product_name: "Hủ Tiếu Xào Thập Cẩm", quantity: 2, unit_price: 60000 }]);
    assert.equal(platform.repos.customerMemory.listOrderRefs(cid(), "ATIEU001").length, 2);
  });
});

test("A Tiểu and Nôm Nôm memories never mix", async () => {
  await withChat(async ({ say }) => {
    await say("Tìm hủ tiếu xào");
    await say("Xem A Tiểu");
    await say("Em không ăn hành");
    await say("Quay lại tổng đài");
    await say("Xem quán Nôm Nôm");
    await say("Cho 1 coca");
    await say("Lấy tại quán");
    assert.doesNotMatch(await say("Đặt hàng"), /không hành/);
    assert.match(await say("như cũ"), /chưa thấy đơn nào/);
  });
});
