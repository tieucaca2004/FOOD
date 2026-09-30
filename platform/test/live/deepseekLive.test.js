// DeepSeek LIVE smoke test — the FOOD Agent built by the PRODUCTION factory (createGptFoodConcierge) on the REAL
// DeepSeek API through the real FallbackProvider / DeepSeekProvider. Opt-in only:
//   FOOD_LIVE_AI_TESTS=1 DEEPSEEK_API_KEY=… FOOD_AGENT_PRIMARY_MODEL=deepseek-flash npm run test:deepseek-live
// NOT part of npm test / test:all; skipped without all three. fetch is NOT mocked: the real fetch is wrapped by an
// observer that records only host, path, HTTP status and the `model` field — never the key, headers or bodies.
// In this process only: the Agent is switched on (OPENAI_ENABLED) and learning is off (nothing is written).
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTestPlatform } from "../helpers/testPlatform.js";
import { createGptFoodConcierge } from "../../ai/index.js";
import { FallbackProvider } from "../../ai/fallbackProvider.js";
import { DeepSeekProvider } from "../../ai/deepseek/DeepSeekProvider.js";
import { platformConfig } from "../../config.js";

const EXPECTED_MODEL = "deepseek-flash";
const QUESTION = "Quán có món hủ tiếu bò không?";
const missing = [
  process.env.FOOD_LIVE_AI_TESTS !== "1" && "FOOD_LIVE_AI_TESTS=1",
  !platformConfig.deepseekApiKey && "DEEPSEEK_API_KEY",
  !platformConfig.foodAgentPrimaryModel && "FOOD_AGENT_PRIMARY_MODEL",
].filter(Boolean);

test("DeepSeek LIVE: FOOD Agent answers one text question on DeepSeek, no fallback", { skip: missing.length > 0 && `required: ${missing.join(", ")}` }, async () => {
  platformConfig.openaiEnabled = true; // test process only; .env is untouched
  platformConfig.foodAgentLearningEnabled = false; // a live test never writes learning candidates

  // observer over the REAL fetch (installed after testPlatform's guard, which lets api.deepseek.com through only with
  // FOOD_LIVE_AI_TESTS=1): records host / path / status / model, never headers, key or bodies
  const calls = [];
  const innerFetch = globalThis.fetch;
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(String(input?.url ?? input));
    const call = { host: url.host, path: url.pathname, status: null, requestModel: null, responseModel: null, hasAuthorization: Boolean(options.headers?.authorization) };
    calls.push(call);
    try {
      call.requestModel = JSON.parse(options.body ?? "{}").model ?? null;
    } catch {}
    const res = await innerFetch(input, options);
    call.status = res.status;
    try {
      call.responseModel = (await res.clone().json())?.model ?? null;
    } catch {}
    return res;
  };

  const logs = [];
  const logger = Object.fromEntries(["info", "warn", "error"].map((level) => [level, (cat, msg, meta) => logs.push({ level, cat, msg, meta })]));
  try {
    const p = buildTestPlatform({ withAtieu: true, atieuEngine: "generic", genericFixtureMerchants: ["MERCHANT003"] });
    const agent = await createGptFoodConcierge({ services: p.services, repos: p.repos, agentSearch: p.agentSearch, merchantRouter: p.merchantRouter, logger });
    assert.ok(agent, "createGptFoodConcierge returned null");
    const provider = agent.provider;
    assert.ok(provider instanceof FallbackProvider, "the Agent's provider is not the FallbackProvider");
    assert.ok(provider.primary instanceof DeepSeekProvider, "the primary provider is not DeepSeekProvider");
    assert.equal(provider.primary.model, EXPECTED_MODEL);
    assert.equal(provider.primary.client.baseUrl, "https://api.deepseek.com");

    const customer = p.services.customers.getOrCreateByZaloUserId("deepseek-live", "Live");
    const session = p.services.sessions.getOrCreate(customer.id);
    const t0 = Date.now();
    const out = await agent.respond({ customer, session, text: QUESTION, reason: "live_test", newRequest: true });
    const ms = Date.now() - t0;

    const deepseek = calls.filter((c) => c.host === "api.deepseek.com");
    const turn = logs.find((l) => l.msg === "gpt concierge turn")?.meta ?? null;
    const fallbackLogs = logs.filter((l) => /fallback|PRIMARY provider/.test(l.msg) && l.msg !== "gpt concierge turn");
    console.log(JSON.stringify({
      endpoint: deepseek[0] ? `https://${deepseek[0].host}${deepseek[0].path}` : null,
      calls: calls.map(({ host, path, status, requestModel, responseModel, hasAuthorization }) => ({ host, path, status, requestModel, responseModel, hasAuthorization })),
      stats: provider.stats,
      turn: turn && { mode: turn.mode, model: turn.model, fallback: turn.fallback, fallbackReason: turn.fallbackReason ?? null, modelCalls: turn.modelCalls, transientRetries: turn.transientRetries, tools: turn.tools.map((t) => t.toolName), usage: turn.usage },
      fallbackLogs: fallbackLogs.map((l) => ({ level: l.level, msg: l.msg, meta: l.meta })),
      latencyMs: ms,
      reply: out?.text ?? null,
    }, null, 2));

    // real DeepSeek calls, all HTTP 200, on the expected model
    assert.ok(deepseek.length > 0, "no request reached api.deepseek.com");
    for (const c of deepseek) {
      assert.equal(c.status, 200, `DeepSeek ${c.path} HTTP ${c.status}`);
      assert.equal(c.requestModel, EXPECTED_MODEL);
      assert.ok(c.hasAuthorization);
    }
    // the Agent answered (valid schema: DeepSeekProvider rejects a non-matching answer as invalid_response)
    assert.ok(out && typeof out.text === "string" && out.text.trim(), `Agent produced no answer (fallbackReason: ${turn?.fallbackReason ?? "?"})`);
    assert.equal(turn?.mode, "gpt");
    assert.equal(turn?.fallback, false);
    // no model fallback: OpenAI never called, FallbackProvider never used it
    assert.equal(provider.stats.primaryFailures, 0, "a DeepSeek call failed");
    assert.equal(provider.stats.fallbackCalls, 0, "the fallback model was called");
    assert.equal(calls.filter((c) => c.host === "api.openai.com").length, 0, "a request went to api.openai.com");
    assert.equal(fallbackLogs.length, 0, "a fallback / primary-error log was written");
    // no secret in anything this test captured or printed
    const captured = JSON.stringify({ calls, logs, reply: out?.text ?? null });
    assert.ok(!captured.includes(platformConfig.deepseekApiKey), "the DeepSeek key appears in captured output");
    assert.doesNotMatch(captured, /Bearer\s|sk-[A-Za-z0-9]{8,}/);
  } finally {
    globalThis.fetch = innerFetch;
  }
});
