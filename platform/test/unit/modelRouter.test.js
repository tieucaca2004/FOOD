// FORM 11 — Model Registry + Model Router: commands, default, per-customer isolation, no silent fallback, logging.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ModelRouter, hashUser } from "../../router/ModelRouter.js";
import { ModelRegistry } from "../../ai/models/ModelRegistry.js";
import { createTelegramModelRouter, telegramUserId } from "../../ai/models/index.js";

const FOUNDER = { id: 1, zalo_user_id: "telegram:1001" };
const FOUNDER_2 = { id: 2, zalo_user_id: "telegram:1002" };
const CUSTOMER = { id: 3, zalo_user_id: "telegram:2002" };
const ZALO_SAME_ID = { id: 4, zalo_user_id: "1001" };
const SESSION = { id: 99 };

function config(over = {}) {
  return { claudeCliEnabled: true, claudeCliTelegramUserIds: ["1001", "1002"], claudeCliTimeoutMs: 1000, openaiTimeoutMs: 1000, modelSelectionTtlMinutes: 60, ...over };
}

function setup({ claudeResult = { ok: true, text: "Claude CLI đang hoạt động." }, cfg = {}, now } = {}) {
  const innerCalls = [];
  const claudeCalls = [];
  const logs = [];
  const inner = { handle: async (req) => (innerCalls.push(req), { replyText: `FOOD: ${req.text}`, session: req.session }), other: () => "inner-method" };
  const claude = { available: true, invoke: async (req) => (claudeCalls.push(req), typeof claudeResult === "function" ? claudeResult(req) : claudeResult) };
  const logger = { info: (c, m, meta) => logs.push({ c, m, meta }), warn: (c, m, meta) => logs.push({ c, m, meta }) };
  const built = createTelegramModelRouter({ inner, config: config(cfg), claude, logger });
  if (now && built.modelRouter) built.modelRouter.now = now;
  const send = (customer, text, extra = {}) => built.router.handle({ customer, session: SESSION, text, ...extra });
  return { ...built, send, innerCalls, claudeCalls, logs };
}

test("default model is the FOOD Agent; the wrapper keeps the inner router's other methods", async () => {
  const t = setup();
  assert.equal(t.modelRouter.selected(FOUNDER).id, "food-agent");
  const r = await t.send(FOUNDER, "bún bò ở đâu");
  assert.equal(r.replyText, "FOOD: bún bò ở đâu");
  assert.equal(t.claudeCalls.length, 0);
  assert.equal(t.router.other(), "inner-method");
});

test("/models lists the enabled models for an allowed user", async () => {
  const t = setup();
  const r = await t.send(FOUNDER, "/models");
  assert.equal(r.replyText, "Models:\n1. FOOD Agent — /model food-agent (đang dùng)\n2. Claude CLI — /model claude-cli");
  assert.equal(t.innerCalls.length, 0);
});

test("/model shows the current model; /model claude-cli and /model gpt-4o switch", async () => {
  const t = setup();
  assert.equal((await t.send(FOUNDER, "/model")).replyText, "Model: FOOD Agent");
  assert.equal((await t.send(FOUNDER, "/model claude-cli")).replyText, "Model: Claude CLI");
  assert.equal((await t.send(FOUNDER, "/model")).replyText, "Model: Claude CLI");
  assert.equal((await t.send(FOUNDER, "/model@FoodBot gpt-4o")).replyText, "Model: FOOD Agent");
  assert.equal(t.modelRouter.selected(FOUNDER).id, "food-agent");
  assert.match((await t.send(FOUNDER, "/model llama")).replyText, /Không có model "llama"/);
});

test("Claude session: text goes to Claude CLI only (not FOOD Knowledge / Ordering) and is labelled", async () => {
  const t = setup();
  await t.send(FOUNDER, "/model claude-cli");
  const r = await t.send(FOUNDER, "Kiểm tra platform router");
  assert.equal(r.replyText, "[Claude CLI]\nClaude CLI đang hoạt động.");
  assert.equal(r.model, "claude-cli");
  assert.equal(t.innerCalls.length, 0);
  assert.equal(t.claudeCalls[0].text, "Kiểm tra platform router");
  // persistence within the session: the next turn is still Claude
  await t.send(FOUNDER, "câu thứ hai");
  assert.equal(t.claudeCalls.length, 2);
  assert.equal(t.innerCalls.length, 0);
});

test("session isolation: A on Claude does not move B", async () => {
  const t = setup();
  await t.send(FOUNDER, "/model claude-cli");
  const b = await t.send(FOUNDER_2, "xin chào");
  assert.equal(b.replyText, "FOOD: xin chào");
  assert.equal(t.modelRouter.selected(FOUNDER_2).id, "food-agent");
  assert.equal(t.modelRouter.selected(FOUNDER).id, "claude-cli");
  // two routers never share state (no global)
  const other = setup();
  assert.equal(other.modelRouter.selected(FOUNDER).id, "food-agent");
});

test("a customer not on the allow-list never sees the Model Router: everything passes through unchanged", async () => {
  const t = setup();
  for (const text of ["/models", "/model", "/model claude-cli", "hello"]) {
    const r = await t.send(CUSTOMER, text);
    assert.equal(r.replyText, `FOOD: ${text}`);
  }
  assert.equal(t.modelRouter.selected(CUSTOMER).id, "food-agent");
  assert.equal(t.claudeCalls.length, 0);
  // a Zalo customer whose raw id equals an allowed Telegram id is not allowed
  assert.equal(telegramUserId(ZALO_SAME_ID), null);
  assert.equal((await t.send(ZALO_SAME_ID, "/models")).replyText, "FOOD: /models");
});

test("Claude failure: clear message, NO fallback to the FOOD Agent", async () => {
  for (const reason of ["unavailable", "timeout", "exit", "invalid_output", "tools_exposed", "output_too_large", "spawn_failed"]) {
    const t = setup({ claudeResult: { ok: false, reason, exitCode: reason === "exit" ? 1 : null } });
    await t.send(FOUNDER, "/model claude-cli");
    const r = await t.send(FOUNDER, "hi");
    assert.equal(r.replyText, "Claude CLI hiện không khả dụng.", reason);
    assert.equal(r.modelError, reason);
    assert.equal(t.innerCalls.length, 0, `${reason} must not fall back`);
  }
  const crash = setup({ claudeResult: () => Promise.reject(new Error("boom")) });
  await crash.send(FOUNDER, "/model claude-cli");
  assert.equal((await crash.send(FOUNDER, "hi")).replyText, "Claude CLI hiện không khả dụng.");
  assert.equal(crash.innerCalls.length, 0);
});

test("a photo while on Claude gets a text-only notice (not sent to the FOOD pipeline)", async () => {
  const t = setup();
  await t.send(FOUNDER, "/model claude-cli");
  const r = await t.send(FOUNDER, "", { inbound: { attachments: [{ type: "image" }] } });
  assert.match(r.replyText, /chỉ nhận tin nhắn chữ/);
  assert.equal(t.innerCalls.length + t.claudeCalls.length, 0);
});

test("long answers are cut to fit one Telegram message", async () => {
  const t = setup({ claudeResult: { ok: true, text: "y".repeat(6000) } });
  await t.send(FOUNDER, "/model claude-cli");
  const r = await t.send(FOUNDER, "long");
  assert.ok(r.replyText.length <= 3900);
  assert.match(r.replyText, /đã cắt bớt/);
});

test("selection expires after the idle TTL and returns to the default", async () => {
  let clock = 0;
  const t = setup({ now: () => clock });
  await t.send(FOUNDER, "/model claude-cli");
  clock = 59 * 60_000;
  assert.equal(t.modelRouter.selected(FOUNDER).id, "claude-cli");
  clock += 61 * 60_000;
  assert.equal(t.modelRouter.selected(FOUNDER).id, "food-agent");
});

test("logging: turn id, hashed user, model, duration, outcome — never the raw id or the text", async () => {
  const t = setup({ claudeResult: { ok: false, reason: "exit", exitCode: 2 } });
  await t.send(FOUNDER, "/model claude-cli");
  await t.send(FOUNDER, "bí mật: mật khẩu 123");
  const turn = t.logs.find((l) => l.m === "model turn failed");
  assert.ok(turn.meta.turnId);
  assert.equal(turn.meta.user, hashUser(FOUNDER.id));
  assert.equal(turn.meta.model, "claude-cli");
  assert.equal(turn.meta.ok, false);
  assert.equal(turn.meta.exitCode, 2);
  assert.equal(typeof turn.meta.durationMs, "number");
  const all = JSON.stringify(t.logs);
  assert.ok(!all.includes("mật khẩu") && !all.includes("telegram:1001"));
});

test("off unless enabled AND someone is listed: Telegram then sees the inner router itself", () => {
  const inner = { handle: async () => ({}) };
  assert.equal(createTelegramModelRouter({ inner, config: config({ claudeCliEnabled: false }), claude: { available: true, invoke: async () => ({}) } }).router, inner);
  assert.equal(createTelegramModelRouter({ inner, config: config({ claudeCliTelegramUserIds: [] }), claude: { available: true, invoke: async () => ({}) } }).router, inner);
});

test("registry: every backend has id / displayName / type / invoke; duplicates refused", () => {
  const r = new ModelRegistry({ defaultModelId: "a" });
  assert.throws(() => r.register({ id: "a", displayName: "A", type: "x" }), /invoke/);
  r.register({ id: "a", displayName: "A", type: "x", enabled: true, invoke: async () => ({}) });
  assert.throws(() => r.register({ id: "a", displayName: "A", type: "x", enabled: true, invoke: async () => ({}) }), /already/);
  const t = setup();
  const claude = t.registry.get("claude");
  assert.equal(claude.id, "claude-cli");
  assert.deepEqual(claude.capabilities, { textOnly: true, tools: false, foodKnowledge: false, ordering: false });
  assert.equal(claude.timeoutMs, 1000);
});
