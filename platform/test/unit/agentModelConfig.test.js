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
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(OPENAI_|FOOD_AGENT_)/.test(k)));
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
