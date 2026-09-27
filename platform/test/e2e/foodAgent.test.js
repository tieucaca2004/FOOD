// FORM 03 — FOOD Agent (the GPT concierge as orchestration layer): model from config (FOOD_AGENT_MODEL, e.g. gpt-4o),
// conversation history for understanding, multi-step tools, safe limits (tool rounds, timeout, tool errors), Fact Guard
// last, ordering never reaching the model. Real webhook, legacy A Tiểu engine, SYNTHETIC knowledge, SCRIPTED model.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTestPlatform, startServer, baseUrl } from "../helpers/testPlatform.js";
import { nhaTrangKnowledge } from "../helpers/nhaTrangKnowledge.js";
import { createFoodKnowledge } from "../../services/foodKnowledgeAdapter.js";
import { GptFoodConcierge } from "../../ai/foodConcierge/GptFoodConcierge.js";
import { FoodTools } from "../../ai/foodConcierge/foodTools.js";
import { createGptFoodConcierge, conversationHistory } from "../../ai/index.js";
import { platformConfig } from "../../config.js";

platformConfig.telegramBotToken = "";
const TEST_SECRET = "test-telegram-secret-value";
const LEGACY = [/tên món, số lượng/, /^Em chưa tìm thấy món này trong menu\.$/];
const OK = "Dạ, em đã xem giúp anh/chị.";

class ScriptedProvider {
  constructor(script) {
    this.script = script;
    this.model = "gpt-4o";
    this.configured = true;
    this.calls = [];
  }
  async respond(req) {
    const snapshot = { ...req, input: [...req.input] }; // the Agent appends to its input between rounds
    this.calls.push(snapshot);
    return this.script(snapshot, this.calls.length);
  }
}
let seqId = 0;
const toolCall = (name, args) => {
  const id = `call_${++seqId}`;
  const item = { type: "function_call", call_id: id, name, arguments: JSON.stringify(args) };
  return { output: [item], functionCalls: [{ callId: id, name, arguments: item.arguments }], text: "", usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } };
};
const final = (reply, items = []) => {
  const text = JSON.stringify({ reply, items });
  return { output: [{ type: "message", content: [{ type: "output_text", text }] }], functionCalls: [], text, usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } };
};
const outputs = (req) => req.input.filter((i) => i.type === "function_call_output").map((i) => JSON.parse(i.output));

async function withAgent(script, fn, { timeoutMs = 5000, maxToolTurns = 4 } = {}) {
  const originalSecret = platformConfig.telegramWebhookSecret;
  platformConfig.telegramWebhookSecret = TEST_SECRET;
  const provider = new ScriptedProvider(script);
  const turns = [];
  const logger = { info: (c, m, meta) => (m === "gpt concierge turn" ? turns.push(meta) : null), warn() {}, error() {} };
  const file = nhaTrangKnowledge();
  const platform = buildTestPlatform({
    withAtieu: true, // legacy A Tiểu engine, as in production
    foodKnowledge: ({ services, merchantRouter }) => createFoodKnowledge({ dbPath: file, services, isRoutable: (m) => merchantRouter.isRoutable(m) }),
    // exactly what the factory builds (createGptFoodConcierge), with the scripted model instead of the network
    gpt: ({ services, repos, agentSearch, merchantRouter }) => new GptFoodConcierge({ provider, tools: new FoodTools({ services, repos, agentSearch, merchantRouter }), logger, timeoutMs, maxToolTurns, history: conversationHistory(repos, 6) }),
  });
  const server = await startServer(platform.app);
  let seq = 0;
  const say = async (text, userId = 7700) => {
    seq += 1;
    const res = await fetch(`${baseUrl(server)}${platformConfig.telegramWebhookPath}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": TEST_SECRET },
      body: JSON.stringify({ update_id: seq, message: { message_id: seq, from: { id: userId, first_name: "A" }, chat: { id: userId, type: "private" }, date: 1, text } }),
    });
    assert.equal(res.status, 200, "the webhook never fails");
    const body = await res.json();
    assert.equal(body.status, "processed", JSON.stringify(body));
    return body.reply_text;
  };
  const session = () => platform.db.prepare(`SELECT s.* FROM platform_sessions s JOIN platform_customers c ON c.id = s.customer_id WHERE c.zalo_user_id = 'telegram:7700'`).get();
  try {
    await fn({ platform, provider, turns, say, session });
  } finally {
    server.close();
    platformConfig.telegramWebhookSecret = originalSecret;
  }
}
const enterATieu = async (say) => {
  await say("Tìm hủ tiếu xào");
  await say("Xem A Tiểu");
};

test("AGENT MODEL: the factory builds the Agent on FOOD_AGENT_MODEL (gpt-4o) with conversation history; default = OPENAI_MODEL; no network", async () => {
  const saved = { ...platformConfig };
  try {
    Object.assign(platformConfig, { openaiEnabled: true, openaiApiKey: "sk-test-FAKE-not-a-real-key", openaiModel: "gpt-5.6-terra", foodAgentModel: "gpt-4o", foodAgentHistoryTurns: 6, founderKnowledgeEnabled: false, foodAliasKnowledgeEnabled: false, searchIntelligenceEnabled: false });
    const p = buildTestPlatform({ withAtieu: true });
    const agent = await createGptFoodConcierge({ services: p.services, repos: p.repos, agentSearch: p.agentSearch, merchantRouter: p.merchantRouter, logger: null });
    assert.equal(agent.provider.model, "gpt-4o");
    assert.equal(typeof agent.history, "function");
    Object.assign(platformConfig, { openaiEnabled: false });
    assert.equal(await createGptFoodConcierge({ services: p.services, repos: p.repos, agentSearch: p.agentSearch, merchantRouter: p.merchantRouter }), null, "OPENAI_ENABLED=false: no Agent at all");
  } finally {
    Object.assign(platformConfig, saved);
  }
});

test("DISCOVERY + GENERAL inside A Tiểu: the Agent is called with current_merchant_id and the conversation; tools run; results come back; no legacy fallback", async () => {
  await withAgent(
    (req) => {
      const text = String(req.input[0].content);
      if (/CUSTOMER: (cho tên quán bán sui cao|bún bò)$/.test(text) && !outputs(req).length) return toolCall("search_food", { query: /sui cao/.test(text) ? "Sủi cảo" : "Bún bò Huế" });
      return final(OK);
    },
    async ({ provider, turns, say, session }) => {
      await enterATieu(say);
      const before = provider.calls.length;
      const replies = [];
      for (const t of ["cho tên quán bán sui cao", "bún bò", "chưa ổn, vẫn còn khờ lắm"]) replies.push(await say(t));
      for (const r of replies) for (const bad of LEGACY) assert.doesNotMatch(r, bad);
      const calls = provider.calls.slice(before);
      assert.ok(calls.length >= 3);
      for (const c of calls) {
        assert.match(String(c.input[0].content), /"current_merchant_id":"cat:ATIEU001"/);
        assert.deepEqual(c.tools.map((t) => t.name).sort(), ["get_customer_cart", "get_menu", "get_merchant", "get_previous_knowledge_results", "get_product", "search_food", "search_merchants"]);
      }
      const searched = calls.filter((c) => outputs(c).length);
      assert.ok(searched.length >= 1, "a search_food result came back to the Agent");
      // the feedback turn sees the conversation (earlier turns), never the current message twice
      const feedback = calls.at(-1).input[0].content;
      assert.match(feedback, /^HISTORY \(earlier turns, for understanding only/);
      assert.match(feedback, /Khách: bún bò/);
      assert.ok(!feedback.split("CONTEXT ")[0].includes("chưa ổn, vẫn còn khờ lắm"), "the current message is not in the history");
      assert.ok(turns.every((t) => t.mode === "gpt" && (t.violations ?? []).length === 0), "every answer passed the Fact Guard");
      assert.ok(turns.at(-1).historyTurns > 0);
      assert.deepEqual([session().context, session().active_merchant_id], ["merchant", "ATIEU001"]);
    }
  );
});

test("MULTI-STEP: previous list -> get_menu -> get_menu -> answer; every result returns to the Agent; no loop", async () => {
  await withAgent(
    (req) => {
      const out = outputs(req);
      if (!/danh sách các món ăn/.test(String(req.input[0].content))) return final(OK);
      if (out.length === 0) return toolCall("get_previous_knowledge_results", {});
      if (out.length === 1) return toolCall("get_menu", { merchant_id: "cat:ATIEU001" });
      if (out.length === 2) return toolCall("get_menu", { merchant_id: "cat:ATIEU001" });
      return final(OK);
    },
    async ({ provider, turns, say }) => {
      await enterATieu(say);
      const before = provider.calls.length;
      const reply = await say("hãy cho tôi danh sách các món ăn thật đầy đủ của 2 quán bạn biết");
      const calls = provider.calls.slice(before);
      assert.equal(calls.length, 4, "3 tool rounds + the answer");
      assert.deepEqual(calls.map((c) => outputs(c).length), [0, 1, 2, 3]);
      assert.ok(outputs(calls[3])[1].products.length > 0, "A Tiểu's menu came back from the catalog tool");
      assert.equal(turns.at(-1).tools.length, 3);
      assert.match(reply, /Dạ, em đã xem giúp anh\/chị\./);
    }
  );
});

test("SAFETY: endless tool calls stop at the round limit; a tool error goes back to the model; a timeout falls back — never a crash", async () => {
  // 1) a model that never stops calling tools
  await withAgent(
    () => toolCall("get_customer_cart", {}),
    async ({ provider, turns, say }) => {
      await enterATieu(say);
      const before = provider.calls.length;
      const reply = await say("chưa ổn, vẫn còn khờ lắm");
      assert.equal(provider.calls.length - before, 4, "maxToolTurns = 3 rounds + the call that exceeded it");
      assert.equal(turns.at(-1).fallbackReason, "max_tool_turns");
      for (const bad of LEGACY) assert.doesNotMatch(reply, bad);
    },
    { maxToolTurns: 3 }
  );
  // 2) a tool that fails (unknown place) and invalid arguments: the error is data for the model, which then answers
  await withAgent(
    (req) => {
      const out = outputs(req);
      if (out.length === 0) return toolCall("get_menu", { merchant_id: "cat:DOES_NOT_EXIST" });
      if (out.length === 1) return toolCall("get_menu", { wrong: 1 });
      return final(OK);
    },
    async ({ provider, turns, say }) => {
      await enterATieu(say);
      const before = provider.calls.length;
      const reply = await say("chưa ổn, vẫn còn khờ lắm");
      const last = provider.calls.at(-1);
      assert.deepEqual(outputs(last).map((o) => o.error), ["MERCHANT_NOT_FOUND", "INVALID_ARGUMENTS"]);
      assert.equal(provider.calls.length - before, 3);
      assert.match(reply, /Dạ, em đã xem giúp anh\/chị\./);
      assert.equal(turns.at(-1).mode, "gpt");
    }
  );
  // 3) a model that never answers: the turn times out and FOOD's own reply is used
  await withAgent(
    () => new Promise(() => {}),
    async ({ turns, say }) => {
      await enterATieu(say);
      const t0 = Date.now();
      const reply = await say("chưa ổn, vẫn còn khờ lắm");
      assert.ok(Date.now() - t0 < 5000);
      assert.ok(reply && !LEGACY.some((re) => re.test(reply)));
      assert.ok(["timeout", "provider_error"].includes(turns.at(-1)?.fallbackReason) || turns.length === 0);
    },
    { timeoutMs: 300 }
  );
});

test("FACT GUARD stays last: an invented price is rejected, retried once, then FOOD's own reply is used", async () => {
  await withAgent(
    () => final("Dạ, bún bò ở đây giá 99.000đ ạ."),
    async ({ turns, say }) => {
      await enterATieu(say);
      const reply = await say("bún bò");
      assert.doesNotMatch(reply, /99\.000/);
      const t = turns.at(-1);
      assert.ok(t.violations.some((v) => v === "UNSUPPORTED_PRICE"), JSON.stringify(t));
      assert.equal(t.mode, "deterministic_fallback");
    }
  );
});

test("ORDERING never reaches the Agent: menu, '2 hủ tiếu xào bò', 'cho 2 tô', address, 'Đặt', phone, 'Xác nhận', 'như cũ', 'Ừ', 'Xác nhận'", async () => {
  await withAgent(
    () => final(OK),
    async ({ platform, provider, say, session }) => {
      await enterATieu(say);
      const before = provider.calls.length;
      assert.match(await say("menu"), /Hủ Tiếu Xào/);
      assert.match(await say("2 hủ tiếu xào bò"), /Hủ Tiếu Xào Bò/);
      await say("cho 2 tô");
      assert.match(await say("Giao 76 Nguyễn Thị Minh Khai"), /Giao tới: 76 Nguyễn Thị Minh Khai/);
      assert.match(await say("Đặt"), /số điện thoại/);
      assert.match(await say("0912345678"), /ĐƠN HÀNG #AT-/);
      assert.match(await say("Xác nhận"), /Đã xác nhận đơn hàng #AT-/);
      assert.match(await say("như cũ"), /đơn lần trước/);
      assert.match(await say("Ừ"), /ĐƠN HÀNG #AT-/);
      assert.match(await say("Xác nhận"), /Đã xác nhận đơn hàng #AT-/);
      assert.equal(provider.calls.length, before, "no ordering turn called the model");
      assert.equal(platform.atieuCtx.db.prepare(`SELECT COUNT(*) AS n FROM orders WHERE status = 'CONFIRMED'`).get().n, 2);
      assert.equal(session().context, "merchant");
    }
  );
});
