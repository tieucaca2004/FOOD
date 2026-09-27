// CONTEXT ROUTING: a merchant context (here A Tiểu, one merchant among others) must never answer a NEW GLOBAL
// question — other places, the area, "ngoài quán này ra". Only questions to / about that place stay with it.
// Through the real Telegram webhook -> PlatformRouter; SYNTHETIC Nha Trang knowledge fixture; GPT off.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTestPlatform, startServer, baseUrl } from "../helpers/testPlatform.js";
import { nhaTrangKnowledge } from "../helpers/nhaTrangKnowledge.js";
import { createFoodKnowledge } from "../../services/foodKnowledgeAdapter.js";
import { classifyConciergeIntent } from "../../nlp/concierge.js";
import { platformConfig } from "../../config.js";

platformConfig.telegramBotToken = "";
const SECRET = "test-telegram-secret-value";
const ATIEU_MENU = /Hủ Tiếu Xào A Tiểu[\s\S]*(?:Thực đơn|thực đơn)|HỦ TIẾU XÀO \(\d+ món\)/;

async function chat(fn) {
  const saved = platformConfig.telegramWebhookSecret;
  platformConfig.telegramWebhookSecret = SECRET;
  const file = nhaTrangKnowledge();
  const p = buildTestPlatform({ withAtieu: true, atieuEngine: "generic", withNomNomDemo: true, foodKnowledge: ({ services, merchantRouter }) => createFoodKnowledge({ dbPath: file, services, isRoutable: (m) => merchantRouter.isRoutable(m) }) });
  const server = await startServer(p.app);
  let seq = 0;
  let user = 60000;
  const conversation = () => {
    const id = ++user;
    const say = async (text) => {
      seq += 1;
      const body = await fetch(`${baseUrl(server)}${platformConfig.telegramWebhookPath}`, { method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": SECRET }, body: JSON.stringify({ update_id: seq, message: { message_id: seq, from: { id, is_bot: false, first_name: "C" }, chat: { id, type: "private" }, date: 1, text } }) }).then((r) => r.json());
      assert.equal(body.status, "processed");
      return body.reply_text;
    };
    const session = () => {
      const c = p.repos.customers.findByZaloUserId(`tg:${id}`) ?? p.db.prepare(`SELECT * FROM platform_customers WHERE zalo_user_id LIKE ? ORDER BY id DESC`).get(`%${id}`);
      return p.db.prepare(`SELECT context, active_merchant_id FROM platform_sessions WHERE customer_id = ? ORDER BY id DESC`).get(c.id);
    };
    return { say, session };
  };
  try {
    await fn({ conversation });
  } finally {
    server.close();
    platformConfig.telegramWebhookSecret = saved;
  }
}

test("1 'Menu A Tiểu' opens A Tiểu (it is a merchant the customer asked for)", async () => {
  await chat(async ({ conversation }) => {
    const c = conversation();
    assert.match(await c.say("Menu A Tiểu"), ATIEU_MENU);
    assert.deepEqual(c.session(), { context: "merchant", active_merchant_id: "ATIEU001" });
  });
});

test("2-3 inside A Tiểu, an area / other-places question is GLOBAL discovery — never A Tiểu's menu", async () => {
  await chat(async ({ conversation }) => {
    for (const q of ["Xung quanh đây có món gì?", "Có quán nào bán bún cá?", "Ngoài quán hủ tiếu ra có bán gì gần đây?"]) {
      const c = conversation();
      await c.say("Menu A Tiểu");
      const reply = await c.say(q);
      assert.doesNotMatch(reply, ATIEU_MENU, q);
      assert.doesNotMatch(reply, /quán chưa có món/, q); // not answered by the merchant
      assert.equal(c.session().context, "platform", q);
    }
    const fish = conversation();
    await fish.say("Menu A Tiểu");
    assert.match(await fish.say("Có quán nào bán bún cá?"), /Bún Cá Mẫu|Bún cá Cô Ba|Bún Cá Mịn/); // searched across FOOD
  });
});

test("4 'A Tiểu có món gì?' -> 'Giá món này?' stays with A Tiểu", async () => {
  await chat(async ({ conversation }) => {
    const c = conversation();
    assert.match(await c.say("A Tiểu có món gì?"), ATIEU_MENU);
    const reply = await c.say("Giá món này?");
    assert.match(reply, /HỦ TIẾU XÀO/); // A Tiểu's own product question
    assert.deepEqual(c.session(), { context: "merchant", active_merchant_id: "ATIEU001" });
  });
});

test("5 'A Tiểu có món gì?' -> 'Còn quán nào khác?' leaves A Tiểu for a global search", async () => {
  await chat(async ({ conversation }) => {
    const c = conversation();
    await c.say("A Tiểu có món gì?");
    const reply = await c.say("Còn quán nào khác?");
    assert.equal(reply, "Anh/chị muốn tìm món gì để em tìm quán khác giúp ạ?");
    assert.equal(c.session().context, "platform");
    assert.doesNotMatch(await c.say("tìm bún cá"), ATIEU_MENU); // the next search is global
  });
});

test("6 'Có bún bò không?' with no context is a global food search — A Tiểu is not a default merchant", async () => {
  await chat(async ({ conversation }) => {
    const c = conversation();
    const reply = await c.say("Có bún bò không?");
    assert.doesNotMatch(reply, ATIEU_MENU);
    assert.doesNotMatch(reply, /quán chưa có món/); // no merchant answered
    assert.equal(c.session().context, "platform");
  });
});

test("7 'A Tiểu có bún bò không?' is a question to A Tiểu (by name, not by default)", async () => {
  await chat(async ({ conversation }) => {
    const c = conversation();
    assert.match(await c.say("A Tiểu có bún bò không?"), /quán chưa có món "bun bo"/);
    assert.deepEqual(c.session(), { context: "merchant", active_merchant_id: "ATIEU001" });
    const nom = conversation();
    assert.match(await nom.say("Nôm Nôm có pizza không?"), /Pizza/i); // any merchant, same rule — nothing A Tiểu-specific
    assert.equal(nom.session().active_merchant_id, "DEMO_NOMNOM001");
  });
});

test("8-9 'Bún Cá Mịn có món gì?' answers that place; 'Còn quán nào khác?' then asks for other places", async () => {
  await chat(async ({ conversation }) => {
    const c = conversation();
    const reply = await c.say("Bún Cá Mịn có món gì?");
    assert.match(reply, /Bún Cá Mịn/);
    assert.doesNotMatch(reply, /Bún Cá Mẫu|Bún cá Cô Ba/); // the place, not every bún cá place
    assert.equal(await c.say("Còn quán nào khác?"), "Anh/chị muốn tìm món gì để em tìm quán khác giúp ạ?");
  });
});

test("KEPT: ordering stays in the merchant; paging a DISH list still pages it; product questions stay local", async () => {
  await chat(async ({ conversation }) => {
    const order = conversation();
    await order.say("Menu A Tiểu");
    assert.match(await order.say("cho tôi 2 hủ tiếu bò"), /Đã thêm 2 × HỦ TIẾU XÀO BÒ/);
    assert.equal(order.session().active_merchant_id, "ATIEU001");
    const list = conversation();
    await list.say("tìm bún cá");
    assert.doesNotMatch(await list.say("còn quán nào nữa?"), /tìm quán khác giúp/); // more of the same list
  });
  // "global" is decided by phrasing, never by which dish or place is named
  for (const [t, g] of [["có Seafood Pizza không", false], ["còn món nào khác không", false], ["quán có giao gần đây không", false], ["Giá món này?", false], ["Xung quanh đây có món gì?", true], ["Có quán nào bán bún bò?", true], ["Còn quán nào khác?", true], ["Ngoài quán hủ tiếu ra có bán gì gần đây?", true]]) {
    assert.equal(classifyConciergeIntent(t).global, g, t);
  }
});
