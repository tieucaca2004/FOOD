// FORM 09 — which model the FOOD Agent actually calls, from the environment alone (each case in a fresh process,
// with dotenv pointed at a file that does not exist, so no .env can leak in). No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { execFileSync } from "node:child_process";

const REPO = path.resolve(import.meta.dirname, "../../..");
const probe = `
  const { platformConfig } = await import(${JSON.stringify(new URL("../../config.js", import.meta.url).href)});
  const { createGptFoodConcierge } = await import(${JSON.stringify(new URL("../../ai/index.js", import.meta.url).href)});
  const { buildTestPlatform } = await import(${JSON.stringify(new URL("../helpers/testPlatform.js", import.meta.url).href)});
  const p = buildTestPlatform({ withAtieu: true });
  const agent = await createGptFoodConcierge({ services: p.services, repos: p.repos, agentSearch: p.agentSearch, merchantRouter: p.merchantRouter });
  console.log(JSON.stringify({ enabled: Boolean(agent), agentModel: agent?.provider?.model ?? null, foodAgentModel: platformConfig.foodAgentModel, openaiModel: platformConfig.openaiModel, timeoutMs: platformConfig.openaiTimeoutMs, maxToolTurns: platformConfig.openaiMaxToolTurns, historyTurns: platformConfig.foodAgentHistoryTurns, learning: platformConfig.foodAgentLearningEnabled, agentLearning: agent ? agent.learning !== null : null }));
`;
const run = (env) => {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(OPENAI_|FOOD_AGENT_|DEEPSEEK_)/.test(k)));
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", probe], { cwd: REPO, env: { ...clean, DOTENV_CONFIG_PATH: path.join(REPO, "no-such.env"), ...env }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return JSON.parse(out.trim().split("\n").filter((l) => l.startsWith("{") && l.includes("agentModel")).at(-1));
};
const KEY = { OPENAI_API_KEY: "sk-test-FAKE-not-a-real-key" }; // never used: nothing is called

test("MODEL PRECEDENCE: FOOD_AGENT_MODEL > OPENAI_MODEL > default; OPENAI_ENABLED alone turns the Agent on", () => {
  assert.ok(!fs.existsSync(path.join(REPO, "no-such.env")));
  const cases = {
    off_by_default: run({ ...KEY }),
    on_nothing_named: run({ ...KEY, OPENAI_ENABLED: "true" }),
    on_openai_model_only: run({ ...KEY, OPENAI_ENABLED: "true", OPENAI_MODEL: "gpt-5.6-terra" }),
    on_food_agent_model: run({ ...KEY, OPENAI_ENABLED: "true", OPENAI_MODEL: "gpt-5.6-terra", FOOD_AGENT_MODEL: "gpt-4o" }),
    on_without_key: run({ OPENAI_ENABLED: "true", FOOD_AGENT_MODEL: "gpt-4o" }),
    enabled_not_exactly_true: run({ ...KEY, OPENAI_ENABLED: "1", FOOD_AGENT_MODEL: "gpt-4o" }),
    learning_on: run({ ...KEY, OPENAI_ENABLED: "true", FOOD_AGENT_MODEL: "gpt-4o", FOOD_AGENT_LEARNING_ENABLED: "true", KNOWLEDGE_INGEST_DB_PATH: path.join(fs.mkdtempSync(path.join(os.tmpdir(), "form09-cfg-")), "working.db"), KNOWLEDGE_INGEST_RAW_ROOT: path.join(os.tmpdir(), "form09-cfg-raw") }),
  };
  assert.deepEqual([cases.off_by_default.enabled, cases.off_by_default.agentModel], [false, null]);
  assert.equal(cases.on_nothing_named.agentModel, "gpt-5.6-terra", "the code default");
  assert.equal(cases.on_openai_model_only.agentModel, "gpt-5.6-terra", "OPENAI_MODEL when FOOD_AGENT_MODEL is unset");
  assert.equal(cases.on_food_agent_model.agentModel, "gpt-4o", "FOOD_AGENT_MODEL wins");
  assert.equal(cases.on_food_agent_model.openaiModel, "gpt-5.6-terra", "OPENAI_MODEL itself is untouched (other features)");
  assert.equal(cases.on_without_key.enabled, false, "no key -> no Agent");
  assert.equal(cases.enabled_not_exactly_true.enabled, false, 'only the exact string "true" enables it');
  for (const c of Object.values(cases)) {
    assert.deepEqual([c.timeoutMs, c.maxToolTurns, c.historyTurns], [15000, 6, 6], "defaults");
  }
  assert.equal(cases.on_food_agent_model.learning, false, "learning OFF unless FOOD_AGENT_LEARNING_ENABLED=true");
  assert.equal(cases.on_food_agent_model.agentLearning, false);
});

test("STARTUP LOG names the model the Agent's provider calls (not OPENAI_MODEL)", () => {
  const src = fs.readFileSync(path.join(REPO, "platform/server.js"), "utf8");
  assert.match(src, /"gpt food concierge enabled", \{ model: gpt\.provider\?\.model \?\? platformConfig\.foodAgentModel/);
});

// Model routing (DeepSeek primary, OpenAI fallback) and the photo reader's model, from the environment alone.
const routingProbe = `
  const { createGptFoodConcierge, createConversationImageReader } = await import(${JSON.stringify(new URL("../../ai/index.js", import.meta.url).href)});
  const { buildTestPlatform } = await import(${JSON.stringify(new URL("../helpers/testPlatform.js", import.meta.url).href)});
  const p = buildTestPlatform({ withAtieu: true });
  const logs = [];
  const logger = { info: (t, m) => logs.push("info " + m), warn: (t, m) => logs.push("warn " + m), error: (t, m) => logs.push("error " + m) };
  const agent = await createGptFoodConcierge({ services: p.services, repos: p.repos, agentSearch: p.agentSearch, merchantRouter: p.merchantRouter, logger });
  const reader = await createConversationImageReader();
  const pr = agent?.provider;
  console.log(JSON.stringify({ routing: true, enabled: Boolean(agent), agentModel: pr?.model ?? null, kind: pr?.constructor?.name ?? null,
    primary: pr?.primary ? { kind: pr.primary.constructor.name, model: pr.primary.model, configured: pr.primary.configured, baseUrl: pr.primary.client.baseUrl, includeReasoning: pr.primary.client.includeReasoning } : null,
    fallback: pr?.fallback ? { kind: pr.fallback.constructor.name, model: pr.fallback.model, configured: pr.fallback.configured, baseUrl: pr.fallback.baseUrl, includeReasoning: pr.fallback.includeReasoning } : null,
    share: pr?.primaryTimeoutShare ?? null, imageModel: reader?.model ?? null, logs }));
`;
const route = (env) => {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(OPENAI_|FOOD_AGENT_|DEEPSEEK_|IMAGE_UNDERSTANDING_)/.test(k)));
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", routingProbe], { cwd: REPO, env: { ...clean, DOTENV_CONFIG_PATH: path.join(REPO, "no-such.env"), ...env }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return JSON.parse(out.trim().split("\n").filter((l) => l.startsWith("{") && l.includes('"routing"')).at(-1));
};
const DEEPSEEK = { DEEPSEEK_API_KEY: "sk-deepseek-FAKE-not-a-real-key" }; // never used: nothing is called
const ROUTED = { ...KEY, ...DEEPSEEK, OPENAI_ENABLED: "true", FOOD_AGENT_PRIMARY_MODEL: "deepseek-flash", FOOD_AGENT_FALLBACK_MODEL: "gpt-4o" };

test("ROUTING: DeepSeek Flash is the primary, GPT-4o the fallback; DeepSeek on its own base URL without include", () => {
  const r = route(ROUTED);
  assert.equal(r.enabled, true);
  assert.equal(r.kind, "FallbackProvider");
  assert.equal(r.agentModel, "deepseek-flash", "the Agent calls DeepSeek first");
  assert.deepEqual(r.primary, { kind: "DeepSeekProvider", model: "deepseek-flash", configured: true, baseUrl: "https://api.deepseek.com", includeReasoning: false });
  assert.deepEqual(r.fallback, { kind: "OpenAIProvider", model: "gpt-4o", configured: true, baseUrl: "https://api.openai.com/v1", includeReasoning: false });
  assert.equal(r.share, 0.6);
  assert.ok(r.logs.includes("info food agent model routing"));
  assert.ok(!r.logs.some((l) => l.startsWith("error") || l.startsWith("warn")), JSON.stringify(r.logs));
  const custom = route({ ...ROUTED, DEEPSEEK_BASE_URL: "https://deepseek.example/", FOOD_AGENT_PRIMARY_TIMEOUT_SHARE: "0.5" });
  assert.equal(custom.primary.baseUrl, "https://deepseek.example");
  assert.equal(custom.share, 0.5);
});

test("ROUTING STATES: no DeepSeek key -> logged error, GPT-4o alone; no OpenAI key -> DeepSeek alone, logged; OPENAI_ENABLED still the switch", () => {
  const noDeepseek = route({ ...ROUTED, DEEPSEEK_API_KEY: "" });
  assert.equal(noDeepseek.enabled, true);
  assert.equal(noDeepseek.primary.configured, false);
  assert.equal(noDeepseek.agentModel, "gpt-4o");
  assert.ok(noDeepseek.logs.includes("error food agent PRIMARY model is set but DEEPSEEK_API_KEY is missing: the Agent runs on the fallback only"));
  const noOpenai = route({ ...ROUTED, OPENAI_API_KEY: "" });
  assert.equal(noOpenai.enabled, true);
  assert.equal(noOpenai.agentModel, "deepseek-flash");
  assert.equal(noOpenai.fallback.configured, false);
  assert.ok(noOpenai.logs.some((l) => l.startsWith("warn food agent has NO fallback model")));
  assert.equal(noOpenai.imageModel, null, "no OpenAI key: no photo reader (never DeepSeek)");
  assert.equal(route({ ...ROUTED, OPENAI_API_KEY: "", DEEPSEEK_API_KEY: "" }).enabled, false);
  assert.equal(route({ ...ROUTED, OPENAI_ENABLED: "false" }).enabled, false, "a key alone never turns the Agent on");
  const legacy = route({ ...KEY, ...DEEPSEEK, OPENAI_ENABLED: "true", FOOD_AGENT_MODEL: "gpt-4o" });
  assert.deepEqual([legacy.kind, legacy.agentModel], ["OpenAIProvider", "gpt-4o"], "no primary model: the OpenAI-only Agent, unchanged");
});

test("VISION stays on OpenAI: the photo reader never gets the DeepSeek model", () => {
  assert.equal(route(ROUTED).imageModel, "gpt-4o", "the fallback (OpenAI) model");
  assert.equal(route({ ...ROUTED, FOOD_AGENT_FALLBACK_MODEL: "", FOOD_AGENT_MODEL: "gpt-4o-mini" }).imageModel, "gpt-4o-mini");
  assert.equal(route({ ...ROUTED, FOOD_AGENT_FALLBACK_MODEL: "", OPENAI_MODEL: "gpt-4.1" }).imageModel, "gpt-4.1");
  assert.equal(route({ ...KEY, OPENAI_ENABLED: "true", FOOD_AGENT_MODEL: "gpt-4o" }).imageModel, "gpt-4o", "as before without routing");
  for (const env of [ROUTED, { ...ROUTED, FOOD_AGENT_FALLBACK_MODEL: "" }]) assert.notEqual(route(env).imageModel, "deepseek-flash");
});
