// FORM 01 — Conversation ownership: the Core (mother call center) owns the conversation; A Tiểu's legacy engine
// answers only the ordering turns it actually handles. The 4 real Telegram failures (production session 3, locked
// inside A Tiểu) are the required regression cases. Real webhook, legacy A Tiểu engine (as in production),
// SYNTHETIC knowledge fixture, scripted GPT (never the real API).
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTestPlatform, startServer, baseUrl } from "../helpers/testPlatform.js";
import { nhaTrangKnowledge } from "../helpers/nhaTrangKnowledge.js";
import { createFoodKnowledge } from "../../services/foodKnowledgeAdapter.js";
import { GptFoodConcierge } from "../../ai/foodConcierge/GptFoodConcierge.js";
import { FoodTools } from "../../ai/foodConcierge/foodTools.js";
import { platformConfig } from "../../config.js";

platformConfig.telegramBotToken = "";
const TEST_SECRET = "test-telegram-secret-value";
const LEGACY_FALLBACKS = [/tên món, số lượng/, /^Em chưa tìm thấy món này trong menu\.$/];
const CASES = ["cho tên quán bán sui cao", "bún bò", "chưa ổn, vẫn còn khờ lắm", "hãy cho tôi danh sách các món ăn thật đầy đủ của 2 quán bạn biết"];

class ScriptedProvider {
  constructor(script = () => final({ reply: "Dạ, em đã xem giúp anh/chị.", items: [] })) {
    this.script = script;
    this.model = "scripted-test-model";
    this.configured = true;
    this.calls = [];
  }
  async respond(req) {
    this.calls.push(req);
    return this.script(req, this.calls.length);
  }
}
let callSeq = 0;
const toolCall = (name, args) => {
  const id = `call_${++callSeq}`;
  const item = { type: "function_call", call_id: id, name, arguments: JSON.stringify(args) };
  return { output: [item], functionCalls: [{ callId: id, name, arguments: item.arguments }], text: "" };
};
const final = (answer) => {
  const text = JSON.stringify(answer);
  return { output: [{ type: "message", content: [{ type: "output_text", text }] }], functionCalls: [], text };
};

async function withChat(fn, { provider = null } = {}) {
  const originalSecret = platformConfig.telegramWebhookSecret;
  platformConfig.telegramWebhookSecret = TEST_SECRET;
  const file = nhaTrangKnowledge();
  const platform = buildTestPlatform({
    withAtieu: true, // the legacy A Tiểu engine, as in production (PLATFORM_ATIEU_ENGINE unset)
    foodKnowledge: ({ services, merchantRouter }) => createFoodKnowledge({ dbPath: file, services, isRoutable: (m) => merchantRouter.isRoutable(m) }),
    gpt: provider ? ({ services, repos, agentSearch, merchantRouter }) => new GptFoodConcierge({ provider, tools: new FoodTools({ services, repos, agentSearch, merchantRouter }), timeoutMs: 5000, maxToolTurns: 3 }) : null,
  });
  const server = await startServer(platform.app);
  let seq = 0;
  const say = async (text, userId = 9900) => {
    seq += 1;
    const res = await fetch(`${baseUrl(server)}${platformConfig.telegramWebhookPath}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": TEST_SECRET },
      body: JSON.stringify({ update_id: seq, message: { message_id: seq, from: { id: userId, is_bot: false, first_name: "K" }, chat: { id: userId, type: "private" }, date: 1, text } }),
    });
    const body = await res.json();
    assert.equal(body.status, "processed", JSON.stringify(body));
    return body.reply_text;
  };
  const session = (userId = 9900) => platform.db.prepare(`SELECT s.* FROM platform_sessions s JOIN platform_customers c ON c.id = s.customer_id WHERE c.zalo_user_id = ?`).get(`telegram:${userId}`);
  const age = (minutes, userId = 9900) => platform.db.prepare(`UPDATE platform_messages SET created_at = datetime(created_at, ?) WHERE session_id = ?`).run(`-${minutes} minutes`, session(userId).id);
  try {
    await fn({ platform, say, session, age });
  } finally {
    server.close();
    platformConfig.telegramWebhookSecret = originalSecret;
  }
}

async function enterATieu(say) {
  await say("Tìm hủ tiếu xào");
  await say("Xem A Tiểu");
}

test("OWNERSHIP (GPT off, like production): inside A Tiểu, the 4 real cases are answered by the Core — never the order parser's fallback; the customer stays in the place", async () => {
  await withChat(async ({ say, session }) => {
    await enterATieu(say);
    assert.equal(session().context, "merchant");
    for (const text of CASES) {
      const reply = await say(text);
      for (const bad of LEGACY_FALLBACKS) assert.doesNotMatch(reply, bad, `${text} -> ${reply}`);
      assert.deepEqual([session().context, session().active_merchant_id], ["merchant", "ATIEU001"], "current merchant kept");
    }
    // the handed-back turn gets exactly the answer a customer at the Core gets for the same words
    assert.equal(await say("bún bò"), await say("bún bò", 9901));
  });
});

test("OWNERSHIP (GPT on, scripted): the 4 cases reach GPT with current_merchant_id; tools run and their results return to GPT", async () => {
  const provider = new ScriptedProvider((req, n) => {
    const text = JSON.stringify(req.input);
    // case 4: GPT asks for the menu of the current place, then answers from the tool result
    if (/danh sách các món ăn/.test(text) && !req.input.some((i) => i.type === "function_call_output")) return toolCall("get_menu", { merchant_id: "cat:ATIEU001" });
    return final({ reply: "Dạ, em đã xem giúp anh/chị.", items: [] });
  });
  await withChat(
    async ({ say }) => {
      await enterATieu(say);
      const before = provider.calls.length;
      const replies = [];
      for (const text of CASES) replies.push(await say(text));
      for (const r of replies) for (const bad of LEGACY_FALLBACKS) assert.doesNotMatch(r, bad);
      const calls = provider.calls.slice(before);
      const customerTexts = calls.map((c) => String(c.input[0]?.content ?? ""));
      for (const t of ["chưa ổn, vẫn còn khờ lắm", "hãy cho tôi danh sách các món ăn thật đầy đủ của 2 quán bạn biết"]) {
        const req = customerTexts.find((c) => c.includes(`CUSTOMER: ${t}`));
        assert.ok(req, `GPT was called for "${t}"`);
        assert.match(req, /"current_merchant_id":"cat:ATIEU001"/);
        assert.match(req, /"in_merchant":true/);
      }
      assert.ok(calls.every((c) => (c.tools ?? []).some((t) => t.name === "get_menu")), "tools are passed to GPT");
      const menuTurn = calls.find((c) => c.input.some((i) => i.type === "function_call_output"));
      assert.ok(menuTurn, "the get_menu result came back to GPT");
      const out = JSON.parse(menuTurn.input.find((i) => i.type === "function_call_output").output);
      assert.equal(out.merchant_id, "cat:ATIEU001");
      assert.ok(out.products.length > 0, "A Tiểu's menu from the runtime catalog");
      assert.match(replies[3], /Dạ, em đã xem giúp anh\/chị\./);
    },
    { provider }
  );
});

test("ORDERING stays with A Tiểu (GPT on but never called): '2 hủ tiếu xào bò', 'menu', address, 'Đặt', phone, 'Xác nhận', 'như cũ'", async () => {
  const provider = new ScriptedProvider();
  await withChat(
    async ({ platform, say, session }) => {
      await enterATieu(say);
      const before = provider.calls.length;
      assert.match(await say("menu"), /Hủ Tiếu Xào/);
      assert.match(await say("2 hủ tiếu xào bò"), /Hủ Tiếu Xào Bò/);
      await say("cho 2 tô"); // an order continuation (quantity) stays with the place
      assert.match(await say("Giao 76 Nguyễn Thị Minh Khai"), /📍 Giao tới: 76 Nguyễn Thị Minh Khai/);
      assert.match(await say("Đặt"), /số điện thoại/);
      assert.match(await say("0912345678"), /ĐƠN HÀNG #AT-/);
      assert.match(await say("Xác nhận"), /Đã xác nhận đơn hàng #AT-/);
      assert.match(await say("như cũ"), /đơn lần trước của anh\/chị ở Hủ Tiếu Xào A Tiểu/);
      assert.match(await say("Ừ"), /ĐƠN HÀNG #AT-/);
      assert.match(await say("Xác nhận"), /Đã xác nhận đơn hàng #AT-/);
      assert.equal(provider.calls.length, before, "no ordering turn went to GPT");
      assert.equal(platform.atieuCtx.db.prepare(`SELECT COUNT(*) AS n FROM orders WHERE status = 'CONFIRMED'`).get().n, 2);
      assert.equal(session().context, "merchant");
      // a product question about the place's OWN menu stays with the place
      assert.match(await say("hủ tiếu xào bò giá bao nhiêu?"), /65\.000/);
      assert.equal(provider.calls.length, before);
    },
    { provider }
  );
});

test("MERCHANT CONTEXT TTL: back at the Core after 60 minutes of silence; kept while an order is being built", async () => {
  await withChat(async ({ say, session, age }) => {
    await enterATieu(say);
    age(59);
    await say("menu");
    assert.equal(session().context, "merchant", "59 minutes: still in the place");
    age(61);
    const reply = await say("bún bò");
    assert.equal(session().context, "platform", "61 minutes idle, no order: back at the Core");
    for (const bad of LEGACY_FALLBACKS) assert.doesNotMatch(reply, bad);
    assert.equal(session().active_merchant_id, null);
  });
  await withChat(async ({ say, session, age }) => {
    await enterATieu(say);
    await say("2 hủ tiếu xào bò");
    age(120);
    assert.match(await say("menu"), /Hủ Tiếu Xào/);
    assert.deepEqual([session().context, session().active_merchant_id], ["merchant", "ATIEU001"], "an active cart keeps the place");
  });
  await withChat(async ({ say, session, age }) => {
    await enterATieu(say);
    await say("2 hủ tiếu xào bò");
    await say("Giao 76 Nguyễn Thị Minh Khai");
    assert.match(await say("Đặt"), /số điện thoại/);
    age(120);
    assert.match(await say("0912345678"), /ĐƠN HÀNG #AT-/, "a checkout in progress is never interrupted");
    assert.equal(session().context, "merchant");
  });
});

test("PLATFORM context: behaviour unchanged — the 4 messages never touch A Tiểu's engine", async () => {
  await withChat(async ({ say, session }) => {
    for (const text of CASES) {
      const reply = await say(text);
      for (const bad of LEGACY_FALLBACKS) assert.doesNotMatch(reply, bad);
      assert.equal(session().context, "platform");
    }
  });
});
