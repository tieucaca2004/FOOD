// GPT-2 (offline part): token usage observability, tool-handler failures and provider errors never
// reaching the customer. SCRIPTED provider (no network); SYNTHETIC knowledge fixture.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTestPlatform, startServer, baseUrl } from "../helpers/testPlatform.js";
import { nhaTrangKnowledge } from "../helpers/nhaTrangKnowledge.js";
import { createFoodKnowledge } from "../../services/foodKnowledgeAdapter.js";
import { FoodTools } from "../../ai/foodConcierge/foodTools.js";
import { FoodAIToolRegistry, createFoodToolRegistry } from "../../ai/foodConcierge/toolRegistry.js";
import { GptFoodConcierge } from "../../ai/foodConcierge/GptFoodConcierge.js";
import { OpenAIProviderError } from "../../ai/openai/OpenAIProvider.js";
import { platformConfig } from "../../config.js";

platformConfig.telegramBotToken = "";
const TEST_SECRET = "test-telegram-secret-value";

const platform = (gpt = null) => {
  const file = nhaTrangKnowledge();
  return buildTestPlatform({ withAtieu: true, atieuEngine: "generic", withNomNomDemo: true, foodKnowledge: ({ services, merchantRouter }) => createFoodKnowledge({ dbPath: file, services, isRoutable: (m) => merchantRouter.isRoutable(m) }), gpt });
};
const scripted = (steps) => ({ model: "scripted-test-model", configured: true, calls: [], async respond(req) { this.calls.push(req); const s = steps.shift(); if (!s) throw new Error("script exhausted"); return typeof s === "function" ? s(req) : s; } });
const toolCall = (name, args, usage = null) => ({ output: [{ type: "function_call", call_id: `c_${name}`, name, arguments: JSON.stringify(args) }], functionCalls: [{ callId: `c_${name}`, name, arguments: JSON.stringify(args) }], text: "", usage });
const final = (answer, usage = null) => ({ output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(answer) }] }], functionCalls: [], text: JSON.stringify(answer), usage });

function concierge(p, steps, { registry = null } = {}) {
  const logs = [];
  const tools = new FoodTools({ services: p.services, repos: p.repos, agentSearch: p.agentSearch, merchantRouter: p.merchantRouter });
  const provider = scripted(steps);
  const c = new GptFoodConcierge({ provider, tools, registry, logger: { info: (a, b, m) => logs.push(m) }, timeoutMs: 5000, maxToolTurns: 6 });
  const customer = p.services.customers.getOrCreateByZaloUserId(`g2-${Math.random()}`, "T");
  return { c, provider, logs, ctx: { customer, session: p.services.sessions.getOrCreate(customer.id) } };
}

test("TOKENS: usage as the API reports it, summed over the turn; null when the API does not report it", async () => {
  const p = platform();
  const reported = concierge(p, [toolCall("search_food", { query: "bún cá" }, { input_tokens: 900, output_tokens: 40, total_tokens: 940 }), final({ reply: "Dạ.", items: [] }, { input_tokens: 1400, output_tokens: 60, total_tokens: 1460 })]);
  await reported.c.respond({ ...reported.ctx, text: "tìm bún cá", reason: "discovery" });
  assert.deepEqual(reported.logs.at(-1).usage, { input_tokens: 2300, output_tokens: 100, total_tokens: 2400 });
  const silent = concierge(p, [final({ reply: "Dạ.", items: [] })]);
  await silent.c.respond({ ...silent.ctx, text: "tìm bún cá", reason: "discovery" });
  assert.equal(silent.logs.at(-1).usage, null); // never estimated
  const partial = concierge(p, [final({ reply: "Dạ.", items: [] }, { input_tokens: 10, output_tokens: 2 })]);
  await partial.c.respond({ ...partial.ctx, text: "tìm bún cá", reason: "discovery" });
  assert.deepEqual(partial.logs.at(-1).usage, { input_tokens: 10, output_tokens: 2, total_tokens: null });
});

test("TOOL FAILURE: a handler error reaches the model as TOOL_FAILED only, and the turn continues", async () => {
  const p = platform();
  const registry = new FoodAIToolRegistry().register({ name: "search_food", description: "d", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false }, handler: async () => { throw new Error("SQLITE_CORRUPT: D:/FOOD/data/knowledge/knowledge.db stack at X"); } });
  const { c, logs, ctx } = concierge(p, [
    toolCall("search_food", { query: "bún cá" }),
    (req) => {
      const out = JSON.parse(req.input.at(-1).output);
      assert.deepEqual(Object.keys(out).sort(), ["error", "message"]);
      assert.equal(out.error, "TOOL_FAILED");
      assert.doesNotMatch(JSON.stringify(out), /SQLITE|knowledge\.db|stack/);
      return final({ reply: "Dạ hiện em chưa tra được, anh/chị thử lại sau giúp em nha.", items: [] });
    },
  ], { registry });
  const out = await c.respond({ ...ctx, text: "tìm bún cá", reason: "discovery" });
  assert.equal(out.text, "Dạ hiện em chưa tra được, anh/chị thử lại sau giúp em nha.");
  assert.equal(logs.at(-1).tools[0].errorType, "TOOL_FAILED");
});

test("NO RAW ERRORS TO THE CUSTOMER: provider failures give the deterministic answer, never an error text or stack", async () => {
  const failures = [
    () => { throw new OpenAIProviderError("http", "OpenAI HTTP 500: {\"error\":{\"message\":\"internal\"}}", 500); },
    () => { throw new OpenAIProviderError("rate_limit", "OpenAI rate limit", 429); },
    () => { throw new OpenAIProviderError("timeout", "OpenAI request timed out"); },
    () => { throw new TypeError("Cannot read properties of undefined (reading 'output') at respond (OpenAIProvider.js:88)"); },
    { output: [], functionCalls: [], text: "{not json" },
  ];
  for (const failure of failures) {
    const steps = [failure, failure];
    const originalSecret = platformConfig.telegramWebhookSecret;
    platformConfig.telegramWebhookSecret = TEST_SECRET;
    const p = platform(({ services, repos, agentSearch, merchantRouter }) => new GptFoodConcierge({ provider: scripted(steps), tools: new FoodTools({ services, repos, agentSearch, merchantRouter }), timeoutMs: 5000, maxToolTurns: 6 }));
    const server = await startServer(p.app);
    try {
      const res = await fetch(`${baseUrl(server)}${platformConfig.telegramWebhookPath}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": TEST_SECRET },
        body: JSON.stringify({ update_id: 1, message: { message_id: 1, from: { id: 7, is_bot: false, first_name: "K" }, chat: { id: 7, type: "private" }, date: 1, text: "tìm quán bún cá ở Nha Trang" } }),
      });
      const body = await res.json();
      assert.equal(body.status, "processed");
      assert.match(body.reply_text, /Em tìm thấy \d+ quán có dữ liệu phù hợp/); // the deterministic answer
      assert.doesNotMatch(body.reply_text, /OpenAI|HTTP 500|rate limit|timed out|TypeError|stack|\.js:\d+|not json/i);
    } finally {
      server.close();
      platformConfig.telegramWebhookSecret = originalSecret;
    }
  }
});

test("ALLOWLIST: the model is offered exactly the 7 read-only tools — no cart / order / payment / catalog mutation", () => {
  const p = platform();
  const names = createFoodToolRegistry(new FoodTools({ services: p.services, repos: p.repos, agentSearch: p.agentSearch, merchantRouter: p.merchantRouter })).definitions().map((d) => d.name);
  assert.equal(names.length, 7);
  for (const forbidden of ["add_to_cart", "remove_from_cart", "create_order", "checkout", "pay", "update_menu", "update_price", "create_merchant"]) assert.ok(!names.includes(forbidden), forbidden);
});
