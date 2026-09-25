// Conversation context after search: follow-ups ("có menu quán ko", "quán ở
// đâu", "cho tôi 2 …") go to the merchant the customer just found — generic
// for every merchant/module. Driven through the real Telegram webhook path
// (SIMULATED updates; bot token blanked, nothing is sent to Telegram).
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTestPlatform, startServer, baseUrl } from "../helpers/testPlatform.js";
import { platformConfig } from "../../config.js";

platformConfig.telegramBotToken = "";

const TEST_SECRET = "test-telegram-secret-value";
const DEMO = "DEMO_NOMNOM001";

async function withChat(fn, options = {}) {
  const originalSecret = platformConfig.telegramWebhookSecret;
  platformConfig.telegramWebhookSecret = TEST_SECRET;
  const platform = buildTestPlatform({ withAtieu: true, withNomNomDemo: true, ...options });
  const server = await startServer(platform.app);
  let seq = 0;
  const say = async (text, userId = 8000) => {
    seq += 1;
    const res = await fetch(`${baseUrl(server)}${platformConfig.telegramWebhookPath}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": TEST_SECRET },
      body: JSON.stringify({
        update_id: seq,
        message: { message_id: seq, from: { id: userId, is_bot: false, first_name: "C" }, chat: { id: userId, type: "private" }, date: 1, text },
      }),
    });
    const body = await res.json();
    assert.equal(body.status, "processed", JSON.stringify(body));
    return body.reply_text;
  };
  const session = (userId = 8000) => {
    const customer = platform.repos.customers.findByZaloUserId(`telegram:${userId}`);
    return platform.services.sessions.getOrCreate(customer.id);
  };
  const searches = () => platform.db.prepare(`SELECT COUNT(*) AS n FROM search_events`).get().n;
  try {
    await fn({ platform, say, session, searches });
  } finally {
    server.close();
    platformConfig.telegramWebhookSecret = originalSecret;
  }
}

const NOMNOM_MENU = /Đã mở \[DEMO\] Nôm Nôm Restaurant[\s\S]*Seafood Pizza - Pizza Hải Sản 28cm: 100\.000đ/;

test("A. search -> 'có menu quán ko' returns that merchant's menu without a new global search", async () => {
  await withChat(async ({ say, session, searches }) => {
    assert.match(await say("tìm quán nom nom"), /\[DEMO\] NÔM NÔM RESTAURANT/);
    const before = searches();
    assert.match(await say("có menu quán ko"), NOMNOM_MENU);
    assert.equal(searches(), before); // no marketplace-wide search ran
    assert.equal(session().context, "merchant");
    assert.equal(session().active_merchant_id, DEMO);
  });
});

test("B. search -> natural menu requests all return the found merchant's menu", async () => {
  for (const followUp of ["có thực đơn ko gửi tui", "xem menu", "cho tôi xem thực đơn", "menu đâu", "quán này có món gì", "co thuc don ko"]) {
    await withChat(async ({ say }) => {
      await say("tìm quán nom nom");
      assert.match(await say(followUp), NOMNOM_MENU, followUp);
    });
  }
});

test("C. search -> 'quán ở đâu' returns the found merchant's address", async () => {
  await withChat(async ({ say }) => {
    await say("tìm quán nom nom");
    assert.equal(
      await say("quán ở đâu"),
      "📍 [DEMO] Nôm Nôm Restaurant: 73/16 Đường Trần Quang Khải, Phường Lộc Thọ, Thành phố Nha Trang, Khánh Hòa"
    );
  });
});

test("D. search -> 'có Seafood Pizza không' answers from that merchant's menu", async () => {
  await withChat(async ({ say }) => {
    await say("tìm quán nom nom");
    assert.match(await say("có Seafood Pizza không"), /Dạ có ạ: Seafood Pizza - Pizza Hải Sản 28cm — 100\.000đ/);
    assert.match(await say("có phở bò không"), /quán chưa có món "pho bo"/);
  });
});

test("E. search -> 'cho tôi 2 Seafood Pizza' adds to THAT merchant's cart", async () => {
  await withChat(async ({ platform, say, session }) => {
    await say("tìm quán nom nom");
    assert.match(await say("cho tôi 2 Seafood Pizza"), /Đã thêm 2 × Seafood Pizza - Pizza Hải Sản 28cm/);
    const customerId = session().customer_id;
    const cart = platform.services.cart.getOrCreateCart(customerId, DEMO);
    assert.deepEqual(cart.items.map((i) => [i.product_name, i.quantity]), [["Seafood Pizza - Pizza Hải Sản 28cm", 2]]);
    assert.match(await say("xem giỏ"), /Tạm tính: 200\.000đ/); // context kept for the next message
  });
});

test("F. several merchants found -> no automatic pick; the customer chooses, then context is set", async () => {
  await withChat(
    async ({ say, session }) => {
      const results = await say("tìm hải sản"); // dishes at several merchants, none named "hải sản"
      assert.ok((session().lastSearchResults || []).length >= 2, results);

      const ask = await say("có menu không");
      assert.match(ask, /lần tìm trước có \d+ quán/);
      assert.equal(session().context, "platform"); // nothing selected yet
      assert.doesNotMatch(ask, /Đã mở/);

      const listed = ask.split("\n").filter((l) => /^\d+\. /.test(l));
      const second = listed[1].replace(/^\d+\. /, "");
      assert.match(await say("2"), new RegExp(`Đã mở ${second.replace(/[[\]()]/g, "\\$&")}`));
      assert.equal(session().context, "merchant");
    },
    { genericFixtureMerchants: ["MERCHANT002"] }
  );
});

test("G. 'Tìm hủ tiếu xào' -> 'có menu không' opens A Tiểu (named by the query), not Nôm Nôm", async () => {
  await withChat(async ({ say, session }) => {
    const found = await say("Tìm hủ tiếu xào");
    assert.match(found, /HỦ TIẾU XÀO A TIỂU/);
    assert.match(found, /\[DEMO\] NÔM NÔM RESTAURANT/); // also a real dish match, listed second
    const menu = await say("có menu không");
    assert.match(menu, /Đã mở Hủ Tiếu Xào A Tiểu/);
    assert.doesNotMatch(menu, /Nôm Nôm/);
    assert.equal(session().active_merchant_id, "ATIEU001");
  });
});

test("H. context is per customer: A in Nôm Nôm and B in A Tiểu never leak into each other", async () => {
  await withChat(async ({ say, session }) => {
    const A = 8101;
    const B = 8102;
    await say("tìm quán nom nom", A);
    await say("Tìm hủ tiếu xào", B);
    assert.match(await say("có menu không", B), /Đã mở Hủ Tiếu Xào A Tiểu/);
    assert.match(await say("có menu không", A), /Đã mở \[DEMO\] Nôm Nôm Restaurant/);
    assert.equal(session(A).active_merchant_id, DEMO);
    assert.equal(session(B).active_merchant_id, "ATIEU001");
    assert.match(await say("quán ở đâu", A), /Nôm Nôm/);
  });
});

test("an explicit merchant name in the follow-up beats the recent merchant", async () => {
  await withChat(async ({ say, session }) => {
    await say("Tìm hủ tiếu xào"); // recent = A Tiểu
    assert.match(await say("xem menu nom nom"), /Đã mở \[DEMO\] Nôm Nôm Restaurant/);
    assert.equal(session().active_merchant_id, DEMO);
  });
});

test("a search with no result keeps the previous merchant as context", async () => {
  await withChat(async ({ say }) => {
    await say("tìm quán nom nom");
    assert.match(await say("Tìm xyzxyz"), /chưa tìm thấy quán/);
    assert.match(await say("có menu không"), NOMNOM_MENU);
  });
});

test("'có quán nào bán … không' is still a marketplace search, even with a recent merchant", async () => {
  await withChat(async ({ say, session }) => {
    await say("Tìm A Tiểu"); // recent = A Tiểu only
    const reply = await say("có quán nào bán pizza không");
    assert.doesNotMatch(reply, /Đã mở/);
    assert.equal(session().context, "platform");
  });
});

test("with no merchant context a follow-up is never guessed", async () => {
  await withChat(async ({ say, session }) => {
    const reply = await say("có menu không", 8300);
    assert.doesNotMatch(reply, /Đã mở/);
    assert.equal(session(8300).context, "platform");
    // "có X không" with no context searches the dish itself
    assert.match(await say("có Seafood Pizza không", 8301), /\[DEMO\] NÔM NÔM RESTAURANT/);
  });
});
