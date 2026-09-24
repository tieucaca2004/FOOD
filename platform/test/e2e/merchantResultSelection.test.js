// Choosing a merchant from the search results the customer was just shown:
// by number ("1", "quán số 2", "chọn quán 1"), by confirmation ("ok",
// "chọn quán này") when exactly one merchant was listed, or by a merchant's
// name on its own. Selection reads only the customer's own session and only
// the result list from the immediately preceding turn; anything ambiguous or
// stale is answered with a question, never with a guess.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTestPlatform, startServer, baseUrl } from "../helpers/testPlatform.js";
import { platformConfig } from "../../config.js";
import { config as atieuConfig } from "../../../src/config.js";

let seq = 0;

async function withPlatform(fn) {
  const platform = buildTestPlatform({ withAtieu: true, genericFixtureMerchants: ["MERCHANT002", "MERCHANT003"] });
  const server = await startServer(platform.app);
  const say = async (userId, text) => {
    const res = await fetch(`${baseUrl(server)}${platformConfig.webhookPath}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event_name: "user_send_text", sender: { id: userId }, message: { text, msg_id: `rs-${++seq}` }, timestamp: Date.now() }),
    });
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    return body.reply_text;
  };
  const sessionOf = (userId) => {
    const customer = platform.repos.customers.findByZaloUserId(userId);
    return customer ? platform.repos.sessions.getActiveByCustomer(customer.id) : null;
  };
  const activeMerchant = (userId) => {
    const s = sessionOf(userId);
    return s && s.context === "merchant" ? s.active_merchant_id : null;
  };
  try {
    return await fn({ platform, say, sessionOf, activeMerchant });
  } finally {
    server.close();
  }
}

// "[1] HỦ TIẾU XÀO A TIỂU" lines of a search reply -> ["HỦ TIẾU XÀO A TIỂU", ...] in order.
function listedNames(reply) {
  const rows = [...reply.matchAll(/^\[(\d+)\] (.+)$/gm)];
  rows.forEach((m, i) => assert.equal(Number(m[1]), i + 1, "results are numbered 1..n"));
  return rows.map((m) => m[2]);
}

async function searchAll(say, user) {
  const reply = await say(user, "tìm cho tôi hủ tiếu");
  const names = listedNames(reply);
  assert.equal(names.length, 3, reply);
  return { reply, names };
}

const OPENED = /^Đã mở /;
const idByUpperName = { "HỦ TIẾU XÀO A TIỂU": "ATIEU001", "MERCHANT 002 (TEST FIXTURE)": "MERCHANT002", "MERCHANT 003 (TEST FIXTURE)": "MERCHANT003" };

test("search results are numbered in the order they are stored, and say how to choose", async () => {
  await withPlatform(async ({ say, sessionOf }) => {
    const { reply, names } = await searchAll(say, "rs-numbered");
    assert.deepEqual(names.map((n) => idByUpperName[n]), sessionOf("rs-numbered").lastSearchResults.map((r) => r.merchant_id));
    assert.match(reply, /\[ XEM HỦ TIẾU XÀO A TIỂU \]/); // the name call to action is kept
    assert.match(reply, /số thứ tự/);
  });
});

test("a number picks that position from the customer's last results", async () => {
  await withPlatform(async ({ say, activeMerchant }) => {
    for (const [i, text] of ["1", "2", "3"].entries()) {
      const user = `rs-num-${i}`;
      const { names } = await searchAll(say, user);
      assert.match(await say(user, text), OPENED, text);
      assert.equal(activeMerchant(user), idByUpperName[names[i]], text);
    }
  });
});

test("'quán số 2', 'chọn quán 2', 'quán 2', 'số 2', '[2]' and 'xem quán 2' all pick the second result", async () => {
  await withPlatform(async ({ say, activeMerchant }) => {
    for (const text of ["quán số 2", "chọn quán 2", "quán 2", "số 2", "[2]", "Chọn quán số 2.", "xem quán 2"]) {
      const user = `rs-phrase-${text}`;
      const { names } = await searchAll(say, user);
      assert.match(await say(user, text), OPENED, text);
      assert.equal(activeMerchant(user), idByUpperName[names[1]], text);
    }
  });
});

test("with exactly one result, 'ok', 'được', 'chọn quán này' and 'vào quán này' open it", async () => {
  await withPlatform(async ({ say, activeMerchant }) => {
    for (const text of ["ok", "OK", "được", "chọn quán này", "vào quán này", "Chọn quán này!"]) {
      const user = `rs-one-${text}`;
      const reply = await say(user, "hủ tiếu xào đặc biệt");
      assert.deepEqual(listedNames(reply), ["HỦ TIẾU XÀO A TIỂU"]);
      assert.match(await say(user, text), OPENED, text);
      assert.equal(activeMerchant(user), "ATIEU001", text);
    }
  });
});

test("with several results, 'ok' and 'chọn quán này' ask for a number and do not guess; the list is kept", async () => {
  await withPlatform(async ({ say, activeMerchant }) => {
    for (const text of ["ok", "được", "chọn quán này"]) {
      const user = `rs-ambig-${text}`;
      const { names } = await searchAll(say, user);
      const reply = await say(user, text);
      assert.doesNotMatch(reply, OPENED, text);
      assert.match(reply, /3 quán/, text);
      assert.equal(activeMerchant(user), null, text);
      assert.match(await say(user, "2"), OPENED);
      assert.equal(activeMerchant(user), idByUpperName[names[1]]);
    }
  });
});

test("a number outside the list is refused with the valid range, and the list is kept", async () => {
  await withPlatform(async ({ say, activeMerchant }) => {
    for (const text of ["0", "4", "99", "quán số 7"]) {
      const user = `rs-range-${text}`;
      const { names } = await searchAll(say, user);
      const reply = await say(user, text);
      assert.doesNotMatch(reply, OPENED, text);
      assert.match(reply, /1 đến 3/, text);
      assert.equal(activeMerchant(user), null, text);
      assert.match(await say(user, "1"), OPENED);
      assert.equal(activeMerchant(user), idByUpperName[names[0]]);
    }
  });
});

test("without a previous search, numbers and confirmations select nothing", async () => {
  await withPlatform(async ({ say, activeMerchant }) => {
    for (const text of ["1", "ok", "chọn quán này", "quán số 1"]) {
      const user = `rs-nolist-${text}`;
      const reply = await say(user, text);
      assert.doesNotMatch(reply, OPENED, text);
      assert.match(reply, /tìm món/, text);
      assert.equal(activeMerchant(user), null, text);
    }
  });
});

test("a merchant's name on its own picks it from the last results", async () => {
  await withPlatform(async ({ say, activeMerchant }) => {
    for (const [text, expected] of [["A Tiểu", "ATIEU001"], ["a tieu", "ATIEU001"], ["Merchant 003", "MERCHANT003"], ["merchant 002 (test fixture)", "MERCHANT002"]]) {
      const user = `rs-name-${text}`;
      await searchAll(say, user);
      assert.match(await say(user, text), OPENED, text);
      assert.equal(activeMerchant(user), expected, text);
    }
  });
});

test("a name matching several listed merchants asks which one; a dish name is still a new search", async () => {
  await withPlatform(async ({ say, activeMerchant, sessionOf }) => {
    await searchAll(say, "rs-name-ambig");
    const reply = await say("rs-name-ambig", "merchant");
    assert.doesNotMatch(reply, OPENED);
    assert.equal(activeMerchant("rs-name-ambig"), null);
    assert.match(await say("rs-name-ambig", "3"), OPENED);

    await searchAll(say, "rs-dish");
    const dish = await say("rs-dish", "hủ tiếu xào"); // also a substring of "Hủ Tiếu Xào A Tiểu"
    assert.doesNotMatch(dish, OPENED);
    assert.equal(listedNames(dish).length, 3);
    assert.equal(sessionOf("rs-dish").lastSearchResults.length, 3);
  });
});

test("a bare merchant name without a previous search does not open anything", async () => {
  await withPlatform(async ({ say, activeMerchant }) => {
    const reply = await say("rs-bare-nolist", "A Tiểu");
    assert.doesNotMatch(reply, OPENED);
    assert.equal(activeMerchant("rs-bare-nolist"), null);
  });
});

test("'vào quán A Tiểu' and 'vào A Tiểu' open the merchant by name, with or without a search", async () => {
  await withPlatform(async ({ say, activeMerchant }) => {
    for (const text of ["vào quán A Tiểu", "vào A Tiểu", "Vào quán a tieu"]) {
      const user = `rs-vao-${text}`;
      assert.match(await say(user, text), OPENED, text);
      assert.equal(activeMerchant(user), "ATIEU001", text);
    }
  });
});

test("an unknown name after a search opens nothing", async () => {
  await withPlatform(async ({ say, activeMerchant }) => {
    await searchAll(say, "rs-unknown");
    const reply = await say("rs-unknown", "quán phở hà nội");
    assert.doesNotMatch(reply, OPENED);
    assert.equal(activeMerchant("rs-unknown"), null);
  });
});

test("the latest search wins, and a search with no results leaves nothing to select", async () => {
  await withPlatform(async ({ say, activeMerchant }) => {
    await searchAll(say, "rs-latest");
    assert.deepEqual(listedNames(await say("rs-latest", "hủ tiếu xào đặc biệt")), ["HỦ TIẾU XÀO A TIỂU"]);
    assert.match(await say("rs-latest", "2"), /1 đến 1|chỉ có 1 quán/);
    assert.equal(activeMerchant("rs-latest"), null);
    assert.match(await say("rs-latest", "1"), OPENED);
    assert.equal(activeMerchant("rs-latest"), "ATIEU001");

    await searchAll(say, "rs-empty");
    assert.match(await say("rs-empty", "phở"), /chưa tìm thấy quán nào/);
    assert.doesNotMatch(await say("rs-empty", "1"), OPENED);
    assert.equal(activeMerchant("rs-empty"), null);
  });
});

test("results only count for the turn right after them: an unrelated turn, or visiting a merchant, ends them", async () => {
  await withPlatform(async ({ say, activeMerchant }) => {
    await searchAll(say, "rs-stale");
    await say("rs-stale", "xin chào");
    assert.doesNotMatch(await say("rs-stale", "1"), OPENED);
    assert.equal(activeMerchant("rs-stale"), null);

    await searchAll(say, "rs-visit");
    assert.match(await say("rs-visit", "1"), OPENED);
    assert.match(await say("rs-visit", "quay lại tổng đài"), /Đã quay lại/);
    assert.doesNotMatch(await say("rs-visit", "2"), OPENED);
    assert.equal(activeMerchant("rs-visit"), null);
  });
});

test("customers select from their own results only", async () => {
  await withPlatform(async ({ say, activeMerchant }) => {
    const a = listedNames(await say("rs-iso-a", "hủ tiếu xào bò"));
    const b = listedNames(await say("rs-iso-b", "hủ tiếu hải sản"));
    assert.equal(a.length, 2);
    assert.equal(b.length, 2);
    assert.notDeepEqual(a.map((n) => idByUpperName[n]).sort(), b.map((n) => idByUpperName[n]).sort());
    assert.match(await say("rs-iso-a", "2"), OPENED);
    assert.match(await say("rs-iso-b", "2"), OPENED);
    assert.equal(activeMerchant("rs-iso-a"), idByUpperName[a[1]]);
    assert.equal(activeMerchant("rs-iso-b"), idByUpperName[b[1]]);
    assert.doesNotMatch(await say("rs-iso-c", "1"), OPENED); // never searched
  });
});

test("inside a merchant, a bare number goes to that merchant, not to result selection", async () => {
  await withPlatform(async ({ say, activeMerchant }) => {
    const { names } = await searchAll(say, "rs-inside");
    const first = idByUpperName[names[0]];
    await say("rs-inside", "1");
    const reply = await say("rs-inside", "2");
    assert.doesNotMatch(reply, OPENED);
    assert.equal(activeMerchant("rs-inside"), first);
  });
});

test("a selected merchant's menu is the one shown and used afterwards", async () => {
  await withPlatform(async ({ say, activeMerchant }) => {
    const { names } = await searchAll(say, "rs-menu");
    const pos = names.findIndex((n) => idByUpperName[n] === "MERCHANT003");
    const opened = await say("rs-menu", String(pos + 1));
    assert.match(opened, /^Đã mở Merchant 003/);
    assert.match(opened, /Hủ Tiếu Xào Bò/);
    assert.doesNotMatch(opened, /Đặc Biệt|Hải Sản|Thập Cẩm/);
    await say("rs-menu", "menu");
    assert.equal(activeMerchant("rs-menu"), "MERCHANT003");
  });
});

test("a listed merchant that became unavailable is reported, not opened", async () => {
  await withPlatform(async ({ platform, say, activeMerchant }) => {
    const reply = await say("rs-susp", "hủ tiếu xào đặc biệt");
    assert.deepEqual(listedNames(reply), ["HỦ TIẾU XÀO A TIỂU"]);
    platform.services.merchants.suspend("ATIEU001");
    platform.registry.invalidate("ATIEU001");
    assert.match(await say("rs-susp", "1"), /hiện không khả dụng/);
    assert.equal(activeMerchant("rs-susp"), null);
  });
});

test("after picking a merchant that became unavailable, the customer can still pick another from the same list", async () => {
  await withPlatform(async ({ platform, say, activeMerchant }) => {
    const { names } = await searchAll(say, "rs-susp-retry");
    const suspended = idByUpperName[names[0]];
    platform.services.merchants.suspend(suspended);
    platform.registry.invalidate(suspended);
    assert.match(await say("rs-susp-retry", "1"), /hiện không khả dụng/);
    assert.match(await say("rs-susp-retry", "2"), OPENED);
    assert.equal(activeMerchant("rs-susp-retry"), idByUpperName[names[1]]);
  });
});

test("Telegram group: two members search, pick by number and order, each from their own results (Bot API intercepted)", async () => {
  const saved = { fetch: globalThis.fetch, token: platformConfig.telegramBotToken, secret: platformConfig.telegramWebhookSecret, atieuToken: atieuConfig.telegramBotToken, atieuChat: atieuConfig.telegramChatId };
  const botApiCalls = [];
  platformConfig.telegramBotToken = "111111:test-selection-bot-token";
  platformConfig.telegramWebhookSecret = "test-selection-webhook-secret";
  atieuConfig.telegramBotToken = "222222:test-selection-owner-token";
  atieuConfig.telegramChatId = "test-selection-owner-chat";
  globalThis.fetch = async (url, options) => {
    if (String(url).startsWith("https://api.telegram.org/")) {
      botApiCalls.push(JSON.parse(options.body));
      return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return saved.fetch(url, options);
  };
  const platform = buildTestPlatform({ withAtieu: true, genericFixtureMerchants: ["MERCHANT002", "MERCHANT003"] });
  const server = await startServer(platform.app);
  const GROUP = -700123;
  let updateId = 880000;
  const say = async (userId, text) => {
    const res = await saved.fetch(`${baseUrl(server)}${platformConfig.telegramWebhookPath}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": "test-selection-webhook-secret" },
      body: JSON.stringify({
        update_id: ++updateId,
        message: { message_id: updateId, from: { id: userId, is_bot: false, first_name: "Khách" }, chat: { id: GROUP, type: "group" }, date: 1, text },
      }),
    });
    const body = await res.json();
    assert.equal(body.status, "processed", JSON.stringify(body));
    return body.reply_text;
  };
  const merchantOf = (userId) => {
    const customer = platform.repos.customers.findByZaloUserId(`telegram:${userId}`);
    const s = platform.repos.sessions.getActiveByCustomer(customer.id);
    return s.context === "merchant" ? s.active_merchant_id : null;
  };
  try {
    const A = 9101;
    const B = 9102;
    const namesA = listedNames(await say(A, "tìm cho tôi hủ tiếu"));
    const namesB = listedNames(await say(B, "hủ tiếu xào bò"));
    const atieuPosA = namesA.findIndex((n) => idByUpperName[n] === "ATIEU001") + 1;
    const otherPosB = namesB.findIndex((n) => idByUpperName[n] === "MERCHANT003") + 1;
    assert.ok(atieuPosA > 0 && otherPosB > 0);

    assert.match(await say(A, String(atieuPosA)), /^Đã mở Hủ Tiếu Xào A Tiểu/);
    assert.match(await say(B, String(otherPosB)), /^Đã mở Merchant 003/);
    assert.equal(merchantOf(A), "ATIEU001");
    assert.equal(merchantOf(B), "MERCHANT003");

    assert.match(await say(A, "cho tôi 2 hủ tiếu xào bò"), /Hủ Tiếu Xào Bò × 2/);
    await say(A, "đặt");
    await say(A, "mang về");
    assert.match(await say(A, "0912345678"), /ĐƠN HÀNG #AT-/);
    assert.match(await say(A, "xác nhận"), /Đã xác nhận đơn hàng #AT-/);

    const customerA = platform.repos.customers.findByZaloUserId(`telegram:${A}`);
    const atieuCustomerA = platform.atieuCtx.repos.customers.findByZaloUserId(`platform:${customerA.id}`);
    const orders = platform.atieuCtx.repos.orders.listByCustomer(atieuCustomerA.id, 10);
    assert.equal(orders.length, 1);
    assert.equal(orders[0].status, "CONFIRMED");
    const detail = platform.atieuCtx.services.orders.getDetail(orders[0].id);
    assert.deepEqual(detail.items.map((i) => [i.product_name, i.quantity]), [["Hủ Tiếu Xào Bò", 2]]);

    // B stayed in Merchant 003; nothing of B's reached A Tiểu.
    assert.equal(merchantOf(B), "MERCHANT003");
    const customerB = platform.repos.customers.findByZaloUserId(`telegram:${B}`);
    assert.equal(platform.atieuCtx.repos.customers.findByZaloUserId(`platform:${customerB.id}`), undefined);

    // Every reply went back to the group chat.
    assert.ok(botApiCalls.length > 0);
    assert.ok(botApiCalls.every((c) => c.chat_id === String(GROUP)));
  } finally {
    server.close();
    globalThis.fetch = saved.fetch;
    platformConfig.telegramBotToken = saved.token;
    platformConfig.telegramWebhookSecret = saved.secret;
    atieuConfig.telegramBotToken = saved.atieuToken;
    atieuConfig.telegramChatId = saved.atieuChat;
  }
});
