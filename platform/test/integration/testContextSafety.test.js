// Guards the test infrastructure itself (TEST-002): no automated test may
// reach a real external API (Telegram, Zalo, OpenAI, Anthropic, DeepSeek), even
// when a developer's .env provides real credentials. Only the live AI tests
// (platform/test/live/*) may reach OpenAI/Anthropic/DeepSeek, and only while
// FOOD_LIVE_AI_TESTS=1 is set; the flag is read at request time.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const moduleUrl = (relative) => JSON.stringify(pathToFileURL(path.resolve(here, relative)).href);

// Runs `body` in a fresh process, from an empty directory (no .env), with the
// given environment. The process's own fetch is replaced by a recorder
// BEFORE the test harness loads, so a request the guard lets through is
// recorded instead of leaving the machine.
function runIsolated(body, env = {}) {
  const script = `
    const passedThrough = [];
    globalThis.fetch = async (url) => { passedThrough.push(String(url)); return new Response("{}", { status: 200 }); };
    await import(${moduleUrl("../helpers/testPlatform.js")});
    const { platformConfig } = await import(${moduleUrl("../../config.js")});
    const { config } = await import(${moduleUrl("../../../src/config.js")});
    const outcome = (url) => fetch(url, { method: "POST" }).then(() => "passed", (e) => (/blocked in tests/.test(e.message) ? "blocked" : "error: " + e.message));
    ${body}
  `;
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "harness-safety-"));
  try {
    const childEnv = { ...process.env, ...env };
    if (!("FOOD_LIVE_AI_TESTS" in env)) delete childEnv.FOOD_LIVE_AI_TESTS;
    return JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script], { cwd, encoding: "utf8", env: childEnv }));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

const TELEGRAM = "https://api.telegram.org/botX/sendMessage";
const ZALO = "https://openapi.zalo.me/v3.0/oa/message/cs";
const OPENAI = "https://api.openai.com/v1/responses";
const ANTHROPIC = "https://api.anthropic.com/v1/messages";
const DEEPSEEK = "https://api.deepseek.com/responses";

test("with real-looking credentials in the environment, the harness clears the messaging tokens and blocks every external API", () => {
  const result = runIsolated(
    `process.stdout.write(JSON.stringify({
      platformZalo: platformConfig.zaloAccessToken,
      platformTelegram: platformConfig.telegramBotToken,
      atieuZalo: config.zaloAccessToken,
      telegram: await outcome(${JSON.stringify(TELEGRAM)}),
      zalo: await outcome(${JSON.stringify(ZALO)}),
      openai: await outcome(${JSON.stringify(OPENAI)}),
      anthropic: await outcome(${JSON.stringify(ANTHROPIC)}),
      deepseek: await outcome(${JSON.stringify(DEEPSEEK)}),
      passedThrough,
    }));`,
    {
      PLATFORM_ZALO_OA_ACCESS_TOKEN: "fake-platform-zalo",
      PLATFORM_TELEGRAM_BOT_TOKEN: "111:fake-platform-telegram",
      ZALO_OA_ACCESS_TOKEN: "fake-atieu-zalo",
      OPENAI_ENABLED: "true",
      OPENAI_API_KEY: "fake-openai-key",
      ANTHROPIC_API_KEY: "fake-anthropic-key",
      DEEPSEEK_API_KEY: "fake-deepseek-key",
      FOOD_AGENT_PRIMARY_MODEL: "deepseek-flash",
    }
  );
  assert.deepEqual(result, {
    platformZalo: "",
    platformTelegram: "",
    atieuZalo: "",
    telegram: "blocked",
    zalo: "blocked",
    openai: "blocked",
    anthropic: "blocked",
    deepseek: "blocked",
    passedThrough: [],
  });
});

test("FOOD_LIVE_AI_TESTS=1 lets only OpenAI, Anthropic and DeepSeek through; messaging APIs stay blocked", () => {
  const result = runIsolated(
    `process.stdout.write(JSON.stringify({
      openai: await outcome(${JSON.stringify(OPENAI)}),
      anthropic: await outcome(${JSON.stringify(ANTHROPIC)}),
      deepseek: await outcome(${JSON.stringify(DEEPSEEK)}),
      telegram: await outcome(${JSON.stringify(TELEGRAM)}),
      zalo: await outcome(${JSON.stringify(ZALO)}),
      passedThrough,
    }));`,
    { FOOD_LIVE_AI_TESTS: "1" }
  );
  assert.deepEqual(result, { openai: "passed", anthropic: "passed", deepseek: "passed", telegram: "blocked", zalo: "blocked", passedThrough: [OPENAI, ANTHROPIC, DEEPSEEK] });
});

test("the live flag is read at request time, and only the exact value 1 counts", () => {
  const result = runIsolated(`
    const seen = {};
    for (const value of [undefined, "true", "yes", "0", " 1", "1"]) {
      if (value === undefined) delete process.env.FOOD_LIVE_AI_TESTS;
      else process.env.FOOD_LIVE_AI_TESTS = value;
      seen[String(value)] = await outcome(${JSON.stringify(OPENAI)});
      seen["deepseek " + String(value)] = await outcome(${JSON.stringify(DEEPSEEK)});
    }
    delete process.env.FOOD_LIVE_AI_TESTS;
    seen.afterUnset = await outcome(${JSON.stringify(OPENAI)});
    process.stdout.write(JSON.stringify(seen));
  `);
  assert.deepEqual(result, {
    undefined: "blocked", true: "blocked", yes: "blocked", 0: "blocked", " 1": "blocked", 1: "passed", afterUnset: "blocked",
    "deepseek undefined": "blocked", "deepseek true": "blocked", "deepseek yes": "blocked", "deepseek 0": "blocked", "deepseek  1": "blocked", "deepseek 1": "passed",
  });
});

test("the normal test scripts never set FOOD_LIVE_AI_TESTS", () => {
  const pkg = JSON.parse(fs.readFileSync(path.resolve(here, "../../../package.json"), "utf8"));
  for (const [name, command] of Object.entries(pkg.scripts)) {
    if (/^test(:platform|:collector|:all)?$/.test(name)) assert.doesNotMatch(command, /FOOD_LIVE_AI_TESTS/, name);
  }
});
