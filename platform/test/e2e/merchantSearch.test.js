// Generic merchant search over the real chat paths (Telegram + Zalo webhooks)
// and the REST search endpoint. SIMULATED inbound updates only — the bot
// token is blanked so nothing is sent to the real Telegram Bot API.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTestPlatform, startServer, baseUrl } from "../helpers/testPlatform.js";
import { platformConfig } from "../../config.js";

platformConfig.telegramBotToken = "";

const TEST_SECRET = "test-telegram-secret-value";
const DEMO_CARD = "[DEMO] NÔM NÔM RESTAURANT";
const ATIEU_CARD = "HỦ TIẾU XÀO A TIỂU";

async function withServer(fn) {
  const originalSecret = platformConfig.telegramWebhookSecret;
  platformConfig.telegramWebhookSecret = TEST_SECRET;
  const platform = buildTestPlatform({ withAtieu: true, withNomNomDemo: true });
  const server = await startServer(platform.app);
  let seq = 0;
  const telegram = async (text, userId) => {
    seq += 1;
    const res = await fetch(`${baseUrl(server)}${platformConfig.telegramWebhookPath}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": TEST_SECRET },
      body: JSON.stringify({
        update_id: seq,
        message: { message_id: seq, from: { id: userId, is_bot: false, first_name: "S" }, chat: { id: userId, type: "private" }, date: 1, text },
      }),
    });
    const body = await res.json();
    assert.equal(body.status, "processed");
    return body.reply_text;
  };
  const zalo = async (text, zaloUserId) => {
    seq += 1;
    const res = await fetch(`${baseUrl(server)}/platform/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event_name: "user_send_text", sender: { id: zaloUserId }, message: { text, msg_id: `m${seq}` }, timestamp: Date.now() }),
    });
    const body = await res.json();
    assert.equal(body.status, "processed");
    return body.reply_text;
  };
  const rest = async (q) => {
    const res = await fetch(`${baseUrl(server)}/api/platform/search?q=${encodeURIComponent(q)}`);
    return res.json();
  };
  try {
    await fn({ platform, telegram, zalo, rest });
  } finally {
    server.close();
    platformConfig.telegramWebhookSecret = originalSecret;
  }
}

// Shop cards in reply order (card title lines only).
const cards = (reply) => reply.split("\n").filter((l) => l === DEMO_CARD || l === ATIEU_CARD);

const CASES = [
  // [message, expected cards in order]
  ["Tìm Nôm Nôm", [DEMO_CARD]],
  ["Tìm quán Nôm Nôm", [DEMO_CARD]],
  ["Nôm Nôm Restaurant", [DEMO_CARD]],
  ["nom nom restaurant", [DEMO_CARD]],
  ["tim quán nomnom", [DEMO_CARD]],
  ["tim quán nom nom", [DEMO_CARD]],
  ["Tìm nhà hàng Nôm Nôm", [DEMO_CARD]],
  ["Cho tôi tìm Nôm Nôm", [DEMO_CARD]],
  ["Tìm giúp tôi Nôm Nôm", [DEMO_CARD]],
  ["demo-nom-nom-restaurant", [DEMO_CARD]],
  ["Tìm pizza", [DEMO_CARD]],
  ["Tìm A Tiểu", [ATIEU_CARD]],
  // A Tiểu matches by name AND product -> first; Nôm Nôm has a real "Hủ tiếu xào Tôm/Gà" dish.
  ["Tìm hủ tiếu xào", [ATIEU_CARD, DEMO_CARD]],
  ["hu tieu xao", [ATIEU_CARD, DEMO_CARD]],
  ["Tìm xyzxyz", []],
];

test("Telegram chat path: every search case finds exactly the right merchants, in order", async () => {
  await withServer(async ({ telegram }) => {
    let userId = 5000;
    for (const [text, expected] of CASES) {
      userId += 1; // fresh customer per case: a clean platform session
      const reply = await telegram(text, userId);
      assert.deepEqual(cards(reply), expected, `"${text}" -> ${reply}`);
      if (expected.length === 0) assert.match(reply, /chưa tìm thấy quán/);
    }
  });
});

test("Zalo chat path: same search behavior (shared PlatformRouter/Discovery)", async () => {
  await withServer(async ({ zalo }) => {
    let n = 0;
    for (const [text, expected] of CASES) {
      n += 1;
      const reply = await zalo(text, `zalo-search-${n}`);
      assert.deepEqual(cards(reply), expected, `"${text}" -> ${reply}`);
    }
  });
});

test("SELECT by name works accented and unaccented, then shows the menu", async () => {
  await withServer(async ({ telegram }) => {
    assert.match(await telegram("Xem quán Nôm Nôm", 6001), /Đã mở \[DEMO\] Nôm Nôm Restaurant/);
    assert.match(await telegram("xem quan nom nom", 6002), /Đã mở \[DEMO\] Nôm Nôm Restaurant/);
    assert.match(await telegram("Xem A Tiểu", 6003), /Đã mở/);
  });
});

test("search then select then menu, and the A Tiểu order flow still works end to end", async () => {
  await withServer(async ({ telegram }) => {
    const u = 6100;
    assert.deepEqual(cards(await telegram("tim quan nom nom", u)), [DEMO_CARD]);
    const menu = await telegram("Xem quán Nôm Nôm", u);
    assert.match(menu, /3 cheeses Pizza - Phô Mai 3 Kiểu 28cm: 100\.000đ/);
    assert.match(await telegram("Quay lại tổng đài", u), /Đã quay lại/);

    assert.equal(cards(await telegram("Tìm hủ tiếu xào", u))[0], ATIEU_CARD);
    assert.match(await telegram("Xem A Tiểu", u), /Đã mở/);
    assert.match(await telegram("Cho tôi 2 hủ tiếu xào bò", u), /× 2/);
  });
});

test("REST GET /api/platform/search uses the same normalization + name matching", async () => {
  await withServer(async ({ rest }) => {
    const ids = (r) => r.organic.map((c) => c.merchant_id);
    assert.deepEqual(ids(await rest("pizza")), ["DEMO_NOMNOM001"]);
    assert.deepEqual(ids(await rest("tìm pizza")), ["DEMO_NOMNOM001"]);
    assert.deepEqual(ids(await rest("nom nom restaurant")), ["DEMO_NOMNOM001"]);
    assert.deepEqual(ids(await rest("hủ tiếu xào")), ["ATIEU001", "DEMO_NOMNOM001"]);
    assert.deepEqual(ids(await rest("xyzxyz")), []);
    const byName = (await rest("Nôm Nôm Restaurant")).organic[0];
    assert.equal(byName.matches.length, 0); // name-only match: no invented dish lines
  });
});

test("an undiscoverable merchant is never returned by name search", async () => {
  await withServer(async ({ platform, telegram }) => {
    platform.repos.merchants.setStatus("DEMO_NOMNOM001", "SUSPENDED");
    platform.registry.invalidate("DEMO_NOMNOM001");
    assert.deepEqual(cards(await telegram("Tìm Nôm Nôm", 6200)), []);
    assert.deepEqual(cards(await telegram("Tìm pizza", 6201)), []);
    assert.match(await telegram("Xem quán Nôm Nôm", 6202), /hiện không khả dụng/);
  });
});
