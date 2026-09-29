// FOOD Agent model routing end to end: real webhook, legacy A Tiểu engine, SYNTHETIC knowledge, the real concierge and
// the real providers (DeepSeekProvider primary, OpenAIProvider GPT-4o fallback) over a FAKE fetch — no network, no key.
// Fallback is per model call: tools run once, learning observes once, orders never reach the model.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTestPlatform, startServer, baseUrl } from "../helpers/testPlatform.js";
import { nhaTrangKnowledge } from "../helpers/nhaTrangKnowledge.js";
import { createFoodKnowledge } from "../../services/foodKnowledgeAdapter.js";
import { GptFoodConcierge } from "../../ai/foodConcierge/GptFoodConcierge.js";
import { FoodTools } from "../../ai/foodConcierge/foodTools.js";
import { createFoodToolRegistry } from "../../ai/foodConcierge/toolRegistry.js";
import { DeepSeekProvider } from "../../ai/deepseek/DeepSeekProvider.js";
import { OpenAIProvider } from "../../ai/openai/OpenAIProvider.js";
import { FallbackProvider } from "../../ai/fallbackProvider.js";
import { conversationHistory } from "../../ai/index.js";
import { platformConfig } from "../../config.js";

platformConfig.telegramBotToken = "";
const TEST_SECRET = "test-telegram-secret-value";
const DEEPSEEK_KEY = "sk-deepseek-FAKE-not-a-real-key";
const OPENAI_KEY = "sk-openai-FAKE-not-a-real-key";
const OK = "Dạ, em đã xem giúp anh/chị.";

// raw Responses API bodies, as the services return them
let seq = 0;
const rCall = (name, args, { reasoning = false, callId = `call_${++seq}` } = {}) => ({
  id: `resp_${seq}`,
  output: [
    ...(reasoning ? [{ type: "reasoning", id: `rs_${seq}`, content: [{ type: "reasoning_text", text: "..." }] }] : []),
    { type: "function_call", id: `fc_${seq}`, call_id: callId, name, arguments: typeof args === "string" ? args : JSON.stringify(args), status: "completed" },
  ],
  usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
});
const rFinal = (answer) => ({ id: `resp_${++seq}`, output: [{ type: "message", id: `msg_${seq}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: typeof answer === "string" ? answer : JSON.stringify(answer) }] }], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } });
const status = (code) => ({ status: code });
const never = (init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))));
const customer = (body) => String(body.input[0].content).split("CUSTOMER: ").at(-1);
const outputs = (body) => body.input.filter((i) => i.type === "function_call_output").map((i) => JSON.parse(i.output));

async function withRouting({ deepseek, openai }, fn, { timeoutMs = 3000, maxToolTurns = 4 } = {}) {
  const originalSecret = platformConfig.telegramWebhookSecret;
  platformConfig.telegramWebhookSecret = TEST_SECRET;
  const calls = { deepseek: [], openai: [] };
  const fetchImpl = async (url, init) => {
    const which = url === "https://deepseek.test/responses" ? "deepseek" : url === "https://openai.test/v1/responses" ? "openai" : null;
    if (!which) throw new Error(`unexpected URL in test: ${url}`);
    const body = JSON.parse(init.body);
    calls[which].push({ body, authorization: init.headers.authorization });
    const out = await (which === "deepseek" ? deepseek : openai)(body, calls[which].length, init);
    if (typeof out?.status === "number") return { ok: out.status < 400, status: out.status, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => out };
  };
  const logs = [];
  const turns = [];
  const logger = {
    info: (t, m, meta) => (m === "gpt concierge turn" ? turns.push(meta) : logs.push({ level: "info", m, meta })),
    warn: (t, m, meta) => logs.push({ level: "warn", m, meta }),
    error: (t, m, meta) => logs.push({ level: "error", m, meta }),
  };
  const provider = new FallbackProvider({
    primary: new DeepSeekProvider({ apiKey: DEEPSEEK_KEY, model: "deepseek-flash", baseUrl: "https://deepseek.test", fetchImpl }),
    fallback: new OpenAIProvider({ apiKey: OPENAI_KEY, model: "gpt-4o", baseUrl: "https://openai.test/v1", includeReasoning: false, fetchImpl }),
    logger,
  });
  const executed = [];
  let observed = 0;
  const learning = { observe: () => { observed += 1; return null; } };
  const file = nhaTrangKnowledge();
  const platform = buildTestPlatform({
    withAtieu: true,
    foodKnowledge: ({ services, merchantRouter }) => createFoodKnowledge({ dbPath: file, services, isRoutable: (m) => merchantRouter.isRoutable(m) }),
    gpt: ({ services, repos, agentSearch, merchantRouter }) => {
      const tools = new FoodTools({ services, repos, agentSearch, merchantRouter });
      const registry = createFoodToolRegistry(tools);
      const execute = registry.execute.bind(registry);
      registry.execute = (name, args, ctx) => {
        executed.push(name);
        return execute(name, args, ctx);
      };
      return new GptFoodConcierge({ provider, tools, registry, logger, timeoutMs, maxToolTurns, history: conversationHistory(repos, 6), learning });
    },
  });
  const server = await startServer(platform.app);
  let n = 0;
  const say = async (text, userId = 7800) => {
    n += 1;
    const res = await fetch(`${baseUrl(server)}${platformConfig.telegramWebhookPath}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": TEST_SECRET },
      body: JSON.stringify({ update_id: n, message: { message_id: n, from: { id: userId, first_name: "A" }, chat: { id: userId, type: "private" }, date: 1, text } }),
    });
    assert.equal(res.status, 200, "the webhook never fails");
    const body = await res.json();
    assert.equal(body.status, "processed", JSON.stringify(body));
    return body.reply_text;
  };
  try {
    await say("Tìm hủ tiếu xào");
    await say("Xem A Tiểu");
    const mark = { deepseek: calls.deepseek.length, openai: calls.openai.length, executed: executed.length, observed, turns: turns.length };
    await fn({ platform, provider, calls, executed, turns, logs, say, mark, observed: () => observed });
  } finally {
    server.close();
    platformConfig.telegramWebhookSecret = originalSecret;
  }
}

const MENU_Q = "hãy cho tôi danh sách các món ăn thật đầy đủ của 2 quán bạn biết";
const CHAT_Q = "chưa ổn, vẫn còn khờ lắm";

test("PRIMARY PATH (menu + price, multi-step, two turns): DeepSeek answers alone with json_object; GPT-4o is never called", async () => {
  await withRouting(
    {
      deepseek: (body) => {
        const out = outputs(body);
        if (customer(body) !== MENU_Q) return rFinal({ reply: OK, items: [] });
        if (out.length === 0) return rCall("get_menu", { merchant_id: "cat:ATIEU001" }, { reasoning: true });
        if (out.length === 1) return rCall("get_product", { merchant_id: "cat:ATIEU001", product_id: out[0].products[0].product_id });
        return rFinal({ reply: OK, items: [{ merchant_id: "cat:ATIEU001", product_ids: [out[1].product_id], note: "" }] });
      },
      openai: () => assert.fail("GPT-4o must not be called"),
    },
    async ({ calls, executed, turns, say, mark }) => {
      const reply = await say(MENU_Q);
      await say(CHAT_Q);
      const ds = calls.deepseek.slice(mark.deepseek);
      assert.equal(ds.length, 4, "3 calls for the menu turn + 1 for the next turn");
      assert.equal(calls.openai.length, 0);
      for (const c of ds) {
        assert.equal(c.authorization, `Bearer ${DEEPSEEK_KEY}`);
        assert.equal(c.body.model, "deepseek-flash");
        assert.equal("include" in c.body, false);
        assert.deepEqual(c.body.text, { format: { type: "json_object" } });
      }
      // DeepSeek -> DeepSeek: its own reasoning item and ids go back unchanged
      assert.ok(ds[1].body.input.some((i) => i.type === "reasoning"));
      assert.ok(ds[1].body.input.some((i) => i.type === "function_call" && i.id));
      assert.deepEqual(executed.slice(mark.executed), ["get_menu", "get_product"], "each tool ran once");
      assert.match(reply, /Dạ, em đã xem giúp anh\/chị\./);
      assert.match(reply, /Hủ Tiếu Xào Bò/, "the product the model referenced");
      assert.match(reply, /65[.,]000/, "its price, printed by FOOD from the catalog (never by the model)");
      const menuTurn = turns[mark.turns];
      assert.equal(menuTurn.mode, "gpt");
      assert.equal(menuTurn.model, "deepseek-flash");
      assert.equal(menuTurn.items, 1);
      assert.match(String(ds[3].body.input[0].content), /^HISTORY/, "the next turn sees the conversation");
    }
  );
});

test("MID-TURN FALLBACK: DeepSeek calls a tool, then fails (503); GPT-4o continues from the tool result — the tool is NOT run again", async () => {
  await withRouting(
    {
      deepseek: (body, n) => (outputs(body).length === 0 ? rCall("get_menu", { merchant_id: "cat:ATIEU001" }, { reasoning: true, callId: "call_ds_menu" }) : status(503)),
      openai: () => rFinal({ reply: OK, items: [] }),
    },
    async ({ calls, executed, turns, logs, say, mark, observed }) => {
      const reply = await say(MENU_Q);
      assert.match(reply, /Dạ, em đã xem giúp anh\/chị\./);
      assert.deepEqual(executed.slice(mark.executed), ["get_menu"], "get_menu ran exactly once");
      assert.equal(calls.deepseek.length - mark.deepseek, 2);
      assert.equal(calls.openai.length, 1);
      const gpt = calls.openai[0];
      assert.equal(gpt.authorization, `Bearer ${OPENAI_KEY}`);
      assert.equal(gpt.body.model, "gpt-4o");
      assert.equal("include" in gpt.body, false);
      assert.equal(gpt.body.text.format.type, "json_schema", "GPT-4o keeps strict structured output");
      assert.equal(gpt.body.text.format.strict, true);
      // the transcript GPT-4o sees: the customer, DeepSeek's call (portable), its one result — no reasoning, no ids
      assert.deepEqual(gpt.body.input.slice(1).map((i) => i.type), ["function_call", "function_call_output"]);
      assert.deepEqual(Object.keys(gpt.body.input[1]).sort(), ["arguments", "call_id", "name", "type"]);
      assert.equal(gpt.body.input[1].call_id, "call_ds_menu");
      assert.equal(gpt.body.input[2].call_id, "call_ds_menu");
      assert.ok(!gpt.body.input.some((i) => i.type === "reasoning"));
      assert.equal(turns.at(-1).mode, "gpt");
      assert.equal(turns.at(-1).tools.length, 1);
      assert.equal(observed() - mark.observed, 1, "learning observed the turn once");
      assert.ok(logs.some((l) => l.m === "food agent provider fallback" && l.meta.status === 503 && l.meta.to === "gpt-4o"));
    }
  );
});

test("MALFORMED DeepSeek output falls back: a final answer outside the schema, and a tool call without call_id", async () => {
  await withRouting(
    {
      deepseek: (body) => (customer(body) === MENU_Q ? rFinal({ reply: OK, items: [{ merchant_id: "cat:ATIEU001" }] }) : rCall("get_menu", { merchant_id: "cat:ATIEU001" }, { callId: "" })),
      openai: (body) => (customer(body) === CHAT_Q && outputs(body).length === 0 ? rCall("get_customer_cart", {}) : rFinal({ reply: OK, items: [] })),
    },
    async ({ calls, executed, turns, logs, say, mark }) => {
      assert.match(await say(MENU_Q), /Dạ, em đã xem giúp anh\/chị\./);
      assert.equal(turns.at(-1).mode, "gpt");
      assert.match(await say(CHAT_Q), /Dạ, em đã xem giúp anh\/chị\./);
      assert.equal(turns.at(-1).mode, "gpt");
      // the malformed DeepSeek tool call was never executed; GPT-4o's own call ran once
      assert.deepEqual(executed.slice(mark.executed), ["get_customer_cart"]);
      assert.equal(calls.deepseek.length - mark.deepseek, 2, "one DeepSeek call per turn: the rest of each turn stays on GPT-4o");
      assert.equal(calls.openai.length, 3);
      assert.equal(logs.filter((l) => l.m === "food agent provider fallback" && l.meta.reason === "invalid_response").length, 2);
    }
  );
});

test("TIMEOUT and 429: DeepSeek is cut at its share of the budget / rate-limited, GPT-4o answers inside the same turn", async () => {
  await withRouting(
    { deepseek: (body, n, init) => (customer(body) === MENU_Q ? never(init) : status(429)), openai: () => rFinal({ reply: OK, items: [] }) },
    async ({ calls, turns, logs, say }) => {
      const t0 = Date.now();
      assert.match(await say(MENU_Q), /Dạ, em đã xem giúp anh\/chị\./);
      const took = Date.now() - t0;
      assert.ok(took >= 1700 && took < 3000, `took ${took}ms (DeepSeek share 1800ms of 3000ms)`);
      assert.equal(turns.at(-1).mode, "gpt");
      assert.match(await say(CHAT_Q), /Dạ, em đã xem giúp anh\/chị\./);
      assert.equal(turns.at(-1).mode, "gpt");
      assert.equal(calls.openai.length, 2);
      assert.deepEqual(logs.filter((l) => l.m === "food agent provider fallback").map((l) => l.meta.reason), ["timeout", "rate_limit"]);
    }
  );
});

test("401 from DeepSeek: a logged configuration error, GPT-4o answers, and DeepSeek is not called again on the next turns", async () => {
  await withRouting(
    { deepseek: () => status(401), openai: () => rFinal({ reply: OK, items: [] }) },
    async ({ calls, turns, logs, say, mark }) => {
      for (const t of [MENU_Q, CHAT_Q, MENU_Q]) assert.match(await say(t), /Dạ, em đã xem giúp anh\/chị\./);
      assert.equal(calls.deepseek.length - mark.deepseek, 1, "one attempt, no retry loop");
      assert.equal(calls.openai.length, 3);
      assert.ok(turns.slice(mark.turns).every((t) => t.mode === "gpt"));
      const err = logs.filter((l) => l.level === "error");
      assert.equal(err.length, 1);
      assert.match(err[0].m, /authentication\/configuration error/);
      assert.ok(!JSON.stringify(logs).includes(DEEPSEEK_KEY) && !JSON.stringify(logs).includes(OPENAI_KEY), "no key in logs");
    }
  );
});

test("NO FALLBACK for the concierge's own decisions: Fact Guard rejection, invalid tool arguments, the tool-round limit", async () => {
  const openai = () => assert.fail("GPT-4o must not be called");
  // Fact Guard: an invented price, rejected, retried once ON DEEPSEEK, then FOOD's own reply
  await withRouting({ deepseek: () => rFinal({ reply: "Dạ, bún bò ở đây giá 99.000đ ạ.", items: [] }), openai }, async ({ calls, turns, say, mark }) => {
    assert.doesNotMatch(await say("bún bò"), /99\.000/);
    assert.equal(turns.at(-1).mode, "deterministic_fallback");
    assert.equal(turns.at(-1).fallbackReason, "fact_guard");
    assert.equal(calls.deepseek.length - mark.deepseek, 2);
    assert.equal(calls.openai.length, 0);
  });
  // invalid tool arguments: the error goes back to DeepSeek, which then answers
  await withRouting(
    { deepseek: (body) => (outputs(body).length === 0 ? rCall("get_menu", { wrong: 1 }) : rFinal({ reply: OK, items: [] })), openai },
    async ({ calls, turns, say }) => {
      assert.match(await say(CHAT_Q), /Dạ, em đã xem giúp anh\/chị\./);
      assert.equal(turns.at(-1).tools[0].errorType, "INVALID_ARGUMENTS");
      assert.equal(calls.openai.length, 0);
    }
  );
  // endless tool calls: stops at the limit, FOOD's own reply
  await withRouting({ deepseek: () => rCall("get_customer_cart", {}), openai }, async ({ calls, turns, say, mark }) => {
    await say(CHAT_Q);
    assert.equal(turns.at(-1).fallbackReason, "max_tool_turns");
    assert.equal(calls.deepseek.length - mark.deepseek, 4);
    assert.equal(calls.openai.length, 0);
  }, { maxToolTurns: 3 });
});

test("ORDERING never reaches either model: a full order while DeepSeek is down creates exactly one order", async () => {
  await withRouting(
    { deepseek: () => status(500), openai: () => rFinal({ reply: OK, items: [] }) },
    async ({ platform, calls, executed, say, mark }) => {
      const count = () => platform.atieuCtx.db.prepare(`SELECT COUNT(*) AS n FROM orders`).get().n;
      const before = count();
      assert.match(await say("menu"), /Hủ Tiếu Xào/);
      assert.match(await say("2 hủ tiếu xào bò"), /Hủ Tiếu Xào Bò/);
      await say("cho 2 tô");
      assert.match(await say("Giao 76 Nguyễn Thị Minh Khai"), /Giao tới: 76 Nguyễn Thị Minh Khai/);
      assert.match(await say("Đặt"), /số điện thoại/);
      assert.match(await say("0912345678"), /ĐƠN HÀNG #AT-/);
      assert.match(await say("Xác nhận"), /Đã xác nhận đơn hàng #AT-/);
      assert.equal(count() - before, 1, "exactly one order");
      assert.equal(platform.atieuCtx.db.prepare(`SELECT COUNT(*) AS n FROM orders WHERE status = 'CONFIRMED'`).get().n, 1);
      assert.equal(calls.deepseek.length, mark.deepseek, "no ordering turn called DeepSeek");
      assert.equal(calls.openai.length, mark.openai, "no ordering turn called GPT-4o");
      assert.equal(executed.length, mark.executed);
    }
  );
});
