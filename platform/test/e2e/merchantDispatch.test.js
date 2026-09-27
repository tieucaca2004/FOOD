// Generic Merchant Order Dispatch over the real Telegram webhook path
// (SIMULATED updates; the reply bot token is blanked; the dispatch channel's
// Telegram transport is a fake — no network call is ever made).
//
// - A Tiểu on the GENERIC engine: a chat order reaches A Tiểu's configured chat.
// - Nôm Nôm (no channel configured): unchanged — nothing is sent.
// - A Tiểu on the LEGACY engine: its own frozen notification path is untouched,
//   and the generic port never sees its orders even if a channel is configured.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTestPlatform, startServer, baseUrl } from "../helpers/testPlatform.js";
import { TelegramDispatchChannel } from "../../services/telegramDispatchChannel.js";
import { platformConfig } from "../../config.js";

platformConfig.telegramBotToken = "";

const TEST_SECRET = "test-telegram-secret-value";
const ATIEU = "ATIEU001";
const NOMNOM = "DEMO_NOMNOM001";
const ATIEU_CHAT = "-1009000000001"; // test value — real destinations live only in merchant config

async function withChat(fn, { atieuEngine = "generic", mode = "ok" } = {}) {
  const originalSecret = platformConfig.telegramWebhookSecret;
  platformConfig.telegramWebhookSecret = TEST_SECRET;
  const telegram = { mode, sent: [] };
  const send = async ({ chatId, text }) => {
    telegram.sent.push({ chatId, text });
    return telegram.mode === "ok" ? { ok: true } : { ok: false, error: "Bad Request: chat not found" };
  };
  const platform = buildTestPlatform({
    withAtieu: true,
    atieuEngine,
    withNomNomDemo: true,
    dispatchChannels: { telegram: new TelegramDispatchChannel({ send }) },
  });
  platform.repos.merchantDispatch.setChannel(ATIEU, { channel: "telegram", destination: ATIEU_CHAT });
  const server = await startServer(platform.app);
  let seq = 0;
  const say = async (text, userId = 9900) => {
    seq += 1;
    const res = await fetch(`${baseUrl(server)}${platformConfig.telegramWebhookPath}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": TEST_SECRET },
      body: JSON.stringify({
        update_id: seq,
        message: { message_id: seq, from: { id: userId, is_bot: false, first_name: "Minh" }, chat: { id: userId, type: "private" }, date: 1, text },
      }),
    });
    const body = await res.json();
    assert.equal(body.status, "processed", JSON.stringify(body));
    return body.reply_text;
  };
  const orders = (merchantId) => platform.db.prepare(`SELECT * FROM orders WHERE merchant_id = ? ORDER BY id`).all(merchantId);
  try {
    await fn({ platform, say, telegram, orders });
  } finally {
    server.close();
    platformConfig.telegramWebhookSecret = originalSecret;
  }
}

test("A Tiểu GENERIC: a chat order is delivered to A Tiểu's configured chat, with items, total and address", async () => {
  await withChat(async ({ platform, say, telegram, orders }) => {
    await say("Xem quán A Tiểu");
    await say("cho 2 hủ tiếu hải sản giao qua 76 Nguyễn Thị Minh Khai");
    await say("thêm 1 cơm chiên cua");
    await say("đặt món");
    const done = await say("xác nhận");
    assert.match(done, /✅ Đã tạo đơn TD-/);
    assert.match(done, /Đơn đã được gửi tới quán\./);
    assert.doesNotMatch(done, new RegExp(ATIEU_CHAT)); // the destination is never shown to a customer

    const [order] = orders(ATIEU);
    assert.equal(order.status, "SENT_TO_MERCHANT");
    assert.equal(telegram.sent.length, 1);
    const { chatId, text } = telegram.sent[0];
    assert.equal(chatId, ATIEU_CHAT);
    assert.match(text, new RegExp(`#${order.order_code}`));
    assert.match(text, /🏪 Hủ Tiếu Xào A Tiểu/);
    assert.match(text, /👤 Khách: Minh/);
    assert.match(text, /HỦ TIẾU XÀO HẢI SẢN × 2 = 150\.000đ/);
    assert.match(text, /CƠM CHIÊN CUA × 1 = 80\.000đ/);
    assert.match(text, /TỔNG: 230\.000đ/);
    assert.match(text, /📍 Địa chỉ: 76 Nguyễn Thị Minh Khai/);
    assert.equal(platform.repos.merchantDispatch.getByOrder(order.id).status, "SENT");
  });
});

test("A Tiểu GENERIC: delivery failure keeps the order, tells the customer honestly, and the retry job delivers it once", async () => {
  await withChat(
    async ({ platform, say, telegram, orders }) => {
      await say("Xem quán A Tiểu");
      await say("cho 1 hủ tiếu bò");
      await say("đặt món");
      await say("lấy tại quán");
      const done = await say("xác nhận");
      assert.match(done, /✅ Đã tạo đơn TD-/);
      assert.match(done, /CHƯA được gửi tới quán \(gửi thông báo cho quán bị lỗi\)/);
      const [order] = orders(ATIEU);
      assert.equal(order.status, "CREATED");
      assert.equal(order.total, 65000);

      telegram.mode = "ok";
      await platform.services.orders.retryFailedDispatches();
      await platform.services.orders.retryFailedDispatches();
      assert.equal(platform.repos.orders.getById(order.id).status, "SENT_TO_MERCHANT");
      assert.equal(telegram.sent.filter((m) => m.chatId === ATIEU_CHAT).length, 2); // failed + delivered, never more
      assert.match(telegram.sent[1].text, /Hình thức: Nhận tại quán/);
    },
    { mode: "fail" }
  );
});

test("Nôm Nôm (no channel configured) is unchanged: order recorded, nothing sent, same customer message", async () => {
  await withChat(async ({ say, telegram, orders }) => {
    await say("Xem quán Nôm Nôm");
    await say("Thêm 1 coca");
    await say("Đặt hàng");
    await say("Lấy tại quán");
    const done = await say("Xác nhận");
    assert.match(done, /CHƯA được gửi tới quán — Tổng Đài chưa có kênh gửi đơn tự động cho quán này\./);
    assert.equal(orders(NOMNOM)[0].status, "CREATED");
    assert.equal(telegram.sent.length, 0);
  });
});

test("merchant isolation in chat: A Tiểu's destination never receives Nôm Nôm's order, and vice versa", async () => {
  await withChat(async ({ platform, say, telegram }) => {
    platform.repos.merchantDispatch.setChannel(NOMNOM, { channel: "telegram", destination: "-1009000000002" });
    await say("Xem quán Nôm Nôm", 9901);
    await say("Thêm 1 coca", 9901);
    await say("Đặt hàng", 9901);
    await say("Lấy tại quán", 9901);
    await say("Xác nhận", 9901);
    await say("Xem quán A Tiểu", 9902);
    await say("cho 1 hủ tiếu bò", 9902);
    await say("đặt món", 9902);
    await say("lấy tại quán", 9902);
    await say("xác nhận", 9902);
    assert.deepEqual(telegram.sent.map((m) => m.chatId), ["-1009000000002", ATIEU_CHAT]);
    assert.match(telegram.sent[0].text, /COCA COLA/);
    assert.doesNotMatch(telegram.sent[0].text, /HỦ TIẾU|A Tiểu/);
    assert.match(telegram.sent[1].text, /HỦ TIẾU XÀO BÒ/);
    assert.doesNotMatch(telegram.sent[1].text, /COCA|Nôm Nôm/);
  });
});

test("A Tiểu LEGACY: its own frozen order flow is untouched; the generic port never sees its orders", async () => {
  await withChat(
    async ({ platform, say, telegram, orders }) => {
      assert.equal(platform.repos.merchants.getById(ATIEU).module, "atieu");
      await say("Xem A Tiểu");
      await say("Cho tôi 2 hủ tiếu thập cẩm");
      await say("Giao 76 Nguyễn Thị Minh Khai");
      assert.match(await say("Đặt"), /số điện thoại/);
      assert.match(await say("0912345678"), /ĐƠN HÀNG #AT-/);
      assert.match(await say("Xác nhận"), /Đã xác nhận đơn hàng #AT-/);
      // the legacy engine confirmed and notified through its OWN path…
      const legacy = platform.atieuCtx.db.prepare(`SELECT * FROM orders ORDER BY id DESC LIMIT 1`).get();
      assert.equal(legacy.status, "CONFIRMED");
      assert.equal(platform.atieuCtx.db.prepare(`SELECT COUNT(*) AS n FROM notifications WHERE order_id = ?`).get(legacy.id).n, 1);
      // …and nothing went through the generic dispatch port or generic orders
      assert.equal(telegram.sent.length, 0);
      assert.equal(orders(ATIEU).length, 0);
    },
    { atieuEngine: "legacy" }
  );
});
