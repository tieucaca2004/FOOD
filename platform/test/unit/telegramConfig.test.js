import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const PLATFORM_CONFIG_URL = pathToFileURL(path.join(REPO_ROOT, "platform/config.js")).href;
const ATIEU_CONFIG_URL = pathToFileURL(path.join(REPO_ROOT, "src/config.js")).href;

const FAKE_PLATFORM_TOKEN = "test-platform-token";
const FAKE_LEGACY_TOKEN = "test-legacy-token";
const FAKE_LEGACY_CHAT = "test-legacy-chat";

// Both config modules read env at import time and run `dotenv/config`,
// which loads ./.env from the cwd. Each case therefore runs in a child
// process whose cwd is an empty temp dir (so a developer's real .env is
// never read) and whose env has every Telegram variable stripped before
// the fake values are applied.
function resolveConfigs(fakeEnv) {
  const cleanEnv = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/TELEGRAM/.test(key) && key !== "DOTENV_CONFIG_PATH")
  );
  const isolatedCwd = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-config-test-"));
  try {
    const script = `
      const { platformConfig } = await import(${JSON.stringify(PLATFORM_CONFIG_URL)});
      const { config } = await import(${JSON.stringify(ATIEU_CONFIG_URL)});
      process.stdout.write(JSON.stringify({
        platformBotToken: platformConfig.telegramBotToken,
        atieuBotToken: config.telegramBotToken,
        atieuChatId: config.telegramChatId,
      }));
    `;
    const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: isolatedCwd,
      env: { ...cleanEnv, ...fakeEnv },
      encoding: "utf8",
    });
    return JSON.parse(out);
  } finally {
    fs.rmSync(isolatedCwd, { recursive: true, force: true });
  }
}

test("platform Telegram config reads PLATFORM_TELEGRAM_BOT_TOKEN, and A Tiểu keeps its own TELEGRAM_* values, when both are set", () => {
  const resolved = resolveConfigs({
    PLATFORM_TELEGRAM_BOT_TOKEN: FAKE_PLATFORM_TOKEN,
    TELEGRAM_BOT_TOKEN: FAKE_LEGACY_TOKEN,
    TELEGRAM_CHAT_ID: FAKE_LEGACY_CHAT,
  });
  assert.equal(resolved.platformBotToken, FAKE_PLATFORM_TOKEN);
  assert.equal(resolved.atieuBotToken, FAKE_LEGACY_TOKEN);
  assert.equal(resolved.atieuChatId, FAKE_LEGACY_CHAT);
});

test("platform Telegram config never falls back to A Tiểu's TELEGRAM_BOT_TOKEN", () => {
  const resolved = resolveConfigs({ TELEGRAM_BOT_TOKEN: FAKE_LEGACY_TOKEN, TELEGRAM_CHAT_ID: FAKE_LEGACY_CHAT });
  assert.equal(resolved.platformBotToken, "");
  assert.equal(resolved.atieuBotToken, FAKE_LEGACY_TOKEN);
});

test("setting only the platform token does not enable A Tiểu's order-notification bot", () => {
  const resolved = resolveConfigs({ PLATFORM_TELEGRAM_BOT_TOKEN: FAKE_PLATFORM_TOKEN });
  assert.equal(resolved.platformBotToken, FAKE_PLATFORM_TOKEN);
  assert.equal(resolved.atieuBotToken, "");
  assert.equal(resolved.atieuChatId, "");
});

test("no platform production file reads the unprefixed TELEGRAM_BOT_TOKEN", () => {
  // Matches an actual env read (process.env.X / process.env["X"]), not a
  // comment that merely names A Tiểu's variable.
  const unprefixedRead = /process\.env(?:\.TELEGRAM_BOT_TOKEN\b|\[\s*["'`]TELEGRAM_BOT_TOKEN["'`]\s*\])/;
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "test" && entry.name !== "node_modules") walk(full);
      } else if (entry.name.endsWith(".js") && unprefixedRead.test(fs.readFileSync(full, "utf8"))) {
        offenders.push(path.relative(REPO_ROOT, full));
      }
    }
  };
  walk(path.join(REPO_ROOT, "platform"));
  assert.deepEqual(offenders, []);
});

test(".env.example declares each Telegram bot-token variable exactly once", () => {
  const lines = fs.readFileSync(path.join(REPO_ROOT, ".env.example"), "utf8").split(/\r?\n/);
  const count = (name) => lines.filter((line) => line.startsWith(`${name}=`)).length;
  assert.equal(count("PLATFORM_TELEGRAM_BOT_TOKEN"), 1);
  assert.equal(count("TELEGRAM_BOT_TOKEN"), 1);
  assert.equal(count("TELEGRAM_CHAT_ID"), 1);
});
