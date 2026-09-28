// FORM 11 — ClaudeCliProvider against a REAL child process (a fake `claude` in test/fixtures, run with node): the
// same spawn / stdin / timeout / kill / parsing path production uses, without calling Claude.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ClaudeCliProvider, resolveClaudeCliCommand, childEnv, redactSecrets, secretValues } from "../../ai/models/ClaudeCliProvider.js";

const FAKE_CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../fixtures/fakeClaudeCli.js");
const SECRETS_ENV = {
  PLATFORM_TELEGRAM_BOT_TOKEN: "123456:telegram-bot-token-value",
  TELEGRAM_WEBHOOK_SECRET: "webhook-secret-value-xyz",
  OPENAI_API_KEY: "sk-openai-key-value-123",
  ANTHROPIC_API_KEY: "sk-ant-key-value-456",
  KNOWLEDGE_CONTRIBUTOR_HASH_KEY: "contributor-hash-key-0123456789abcdef",
};

function provider(opts = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "food-claude-cli-test-"));
  return new ClaudeCliProvider({ command: process.execPath, prefixArgs: [FAKE_CLI], cwd, timeoutMs: 10_000, env: { ...process.env, ...SECRETS_ENV }, ...opts });
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("success: the answer is the stream-json result, prompt goes through stdin", async () => {
  const r = await provider().invoke({ text: "Kiểm tra platform router" });
  assert.deepEqual(r, { ok: true, text: "echo: Kiểm tra platform router", exitCode: 0 });
});

test("fixed argv: tools disabled, no MCP, restricted, headless; the user text is never an argument", async () => {
  const p = provider();
  const r = await p.invoke({ text: "ARGS hello" });
  assert.equal(r.ok, true);
  const { argv, prompt } = JSON.parse(r.text);
  assert.equal(prompt, "ARGS hello");
  assert.ok(!argv.some((a) => a.includes("hello")));
  const i = argv.indexOf("--tools");
  assert.ok(i >= 0 && argv[i + 1] === "", "--tools must be followed by an empty list");
  for (const flag of ["-p", "--strict-mcp-config", "--restricted", "--no-session-persistence"]) assert.ok(argv.includes(flag), flag);
  assert.equal(argv[argv.indexOf("--permission-prompts") + 1], "none");
  assert.ok(!argv.some((a) => /dangerously|bypassPermissions|--add-dir|--mcp-config|--allowedTools/.test(a)));
});

test("malicious input: shell metacharacters are plain stdin text — nothing is executed", async () => {
  const p = provider();
  const evil = `ARGS "; rm -rf / & echo pwned > pwned.txt | $(whoami) \`id\` && del /q * %PATH% ^& calc`;
  const r = await p.invoke({ text: evil });
  assert.equal(r.ok, true);
  assert.equal(JSON.parse(r.text).prompt, evil);
  assert.equal(fs.existsSync(path.join(p.cwd, "pwned.txt")), false);
  assert.equal(fs.existsSync("pwned.txt"), false);
});

test("timeout: the process is killed and the turn fails closed", async () => {
  const p = provider({ timeoutMs: 800 });
  const started = Date.now();
  const r = await p.invoke({ text: "HANG" });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "timeout");
  assert.ok(Date.now() - started < 8000);
  const pid = Number(fs.readFileSync(path.join(p.cwd, "hang.pid"), "utf8"));
  for (let i = 0; i < 20 && alive(pid); i++) await new Promise((res) => setTimeout(res, 100));
  assert.equal(alive(pid), false, "the CLI process must not outlive its timeout");
  assert.equal(p.running, 0);
});

test("non-zero exit: fails closed with the exit code; stderr never reaches the result", async () => {
  const r = await provider().invoke({ text: "EXIT3" });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "exit");
  assert.equal(r.exitCode, 3);
  assert.ok(!JSON.stringify(r).includes("leak"));
});

test("unavailable: no executable configured, or a path that does not exist", async () => {
  assert.deepEqual(await new ClaudeCliProvider({ command: null }).invoke({ text: "hi" }), { ok: false, reason: "unavailable" });
  const r = await provider({ command: path.join(os.tmpdir(), "no-such-claude-binary.exe"), prefixArgs: [] }).invoke({ text: "hi" });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "unavailable");
});

test("tools exposed: an init event listing any tool is refused (no arbitrary execution backend)", async () => {
  const r = await provider().invoke({ text: "TOOLS" });
  assert.deepEqual(r, { ok: false, reason: "tools_exposed", exitCode: 0 });
});

test("invalid / error / oversized output all fail closed", async () => {
  assert.equal((await provider().invoke({ text: "GARBAGE" })).reason, "invalid_output");
  assert.equal((await provider().invoke({ text: "ERROR" })).reason, "invalid_output");
  assert.equal((await provider({ maxOutputBytes: 64 * 1024 }).invoke({ text: "BIG" })).reason, "output_too_large");
});

test("child environment: no token / key / secret is inherited", async () => {
  const r = await provider().invoke({ text: "ENV" });
  assert.equal(r.ok, true);
  const keys = JSON.parse(r.text).map((k) => k.toUpperCase());
  for (const k of Object.keys(SECRETS_ENV)) assert.ok(!keys.includes(k), k);
  assert.ok(!keys.some((k) => /TOKEN|SECRET|API_KEY/.test(k)));
  assert.deepEqual(Object.keys(childEnv({ PATH: "x", OPENAI_API_KEY: "y", APPDATA: "z" })).sort(), ["APPDATA", "PATH"]);
});

test("secret redaction: a secret value in the answer never reaches the reply", async () => {
  const r = await provider().invoke({ text: `SECRET ${SECRETS_ENV.PLATFORM_TELEGRAM_BOT_TOKEN}` });
  assert.equal(r.ok, true);
  assert.equal(r.text, "token is [REDACTED]");
  assert.equal(redactSecrets("a sk-openai-key-value-123 b", secretValues(SECRETS_ENV)), "a [REDACTED] b");
});

test("limits: empty / too long prompts and concurrency", async () => {
  const p = provider({ maxConcurrent: 1, timeoutMs: 1500, maxPromptChars: 50 });
  assert.equal((await p.invoke({ text: "   " })).reason, "empty_prompt");
  assert.equal((await p.invoke({ text: "x".repeat(51) })).reason, "prompt_too_long");
  const first = p.invoke({ text: "HANG" });
  assert.equal((await p.invoke({ text: "hi" })).reason, "busy");
  assert.equal((await first).reason, "timeout");
});

test("resolveClaudeCliCommand: never a shell shim; PATH, then the npm global binary", () => {
  const has = (set) => (p) => set.has(p);
  assert.equal(resolveClaudeCliCommand({ configured: "C:\\npm\\claude.cmd", exists: () => true }), null);
  assert.equal(resolveClaudeCliCommand({ configured: "C:\\x\\claude.ps1", exists: () => true }), null);
  assert.equal(resolveClaudeCliCommand({ configured: "/opt/claude", exists: () => false }), null);
  assert.equal(resolveClaudeCliCommand({ configured: "/opt/claude", exists: () => true }), "/opt/claude");
  const winBin = path.join("C:\\Users\\u\\AppData\\Roaming", "npm", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
  assert.equal(resolveClaudeCliCommand({ platform: "win32", env: { PATH: "", APPDATA: "C:\\Users\\u\\AppData\\Roaming" }, exists: has(new Set([winBin])) }), winBin);
  assert.equal(resolveClaudeCliCommand({ platform: "win32", env: { PATH: "", APPDATA: "C:\\none" }, exists: () => false }), null);
});
