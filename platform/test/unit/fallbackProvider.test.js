// FallbackProvider with FAKE providers — no network. Fallback is per model call: the same request goes to the
// fallback, within the same time budget; 401/403 is a logged configuration error that skips the primary for a
// cool-down (never a retry loop); items one provider produced are cleaned, in a copy, before the other sees them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { FallbackProvider } from "../../ai/fallbackProvider.js";
import { OpenAIProviderError } from "../../ai/openai/OpenAIProvider.js";

class FakeProvider {
  constructor(model, script) {
    this.model = model;
    this.configured = true;
    this.name = model;
    this.script = script;
    this.calls = [];
  }
  async respond(req) {
    this.calls.push({ ...req, input: structuredClone(req.input) });
    return this.script(req, this.calls.length);
  }
}
const final = (text = '{"reply":"Dạ","items":[]}') => ({ id: "r", output: [{ type: "message", id: "msg_1", role: "assistant", content: [{ type: "output_text", text }] }], functionCalls: [], text, usage: null });
const fail = (kind, status = null) => () => {
  throw new OpenAIProviderError(kind, `DeepSeek ${kind}`, status);
};
function logs() {
  const entries = [];
  const at = (level) => (tag, msg, meta) => entries.push({ level, msg, meta });
  return { entries, logger: { info: at("info"), warn: at("warn"), error: at("error") } };
}
const req = (input = [{ role: "user", content: "CUSTOMER: phở" }], timeoutMs = 2000) => ({ instructions: "I", input, tools: [], format: null, timeoutMs });

test("PRIMARY SUCCESS: DeepSeek answers, GPT-4o is never called", async () => {
  const primary = new FakeProvider("deepseek-flash", () => final());
  const fallback = new FakeProvider("gpt-4o", () => final());
  const p = new FallbackProvider({ primary, fallback });
  assert.equal(p.model, "deepseek-flash");
  assert.equal(p.configured, true);
  assert.deepEqual(p.describe(), { primary: { model: "deepseek-flash", configured: true }, fallback: { model: "gpt-4o", configured: true }, primaryTimeoutShare: 0.6 });
  const res = await p.respond(req());
  assert.equal(res.text, '{"reply":"Dạ","items":[]}');
  assert.equal(primary.calls.length, 1);
  assert.equal(fallback.calls.length, 0);
  assert.equal(primary.calls[0].timeoutMs, 1200, "the primary gets its share of the time left");
});

test("FALLBACK on timeout, network, 429, 5xx, 400/404 and invalid_response: GPT-4o gets the same request with the rest of the budget", async () => {
  for (const [name, script] of [
    ["timeout", fail("timeout")],
    ["network", fail("network")],
    ["429", fail("rate_limit", 429)],
    ["500", fail("http", 500)],
    ["503", fail("http", 503)],
    ["400 incompatible request", fail("http", 400)],
    ["404 wrong path", fail("http", 404)],
    ["malformed / schema", fail("invalid_response")],
    ["unexpected throw", () => { throw new TypeError("boom"); }],
  ]) {
    const { entries, logger } = logs();
    const primary = new FakeProvider("deepseek-flash", script);
    const fallback = new FakeProvider("gpt-4o", () => final());
    const p = new FallbackProvider({ primary, fallback, logger });
    const r = req();
    const res = await p.respond(r);
    assert.equal(res.text, '{"reply":"Dạ","items":[]}', name);
    assert.equal(primary.calls.length, 1, name);
    assert.equal(fallback.calls.length, 1, name);
    assert.equal(fallback.calls[0].instructions, "I");
    assert.deepEqual(fallback.calls[0].input, r.input, `${name}: same transcript`);
    assert.ok(fallback.calls[0].timeoutMs > 1500 && fallback.calls[0].timeoutMs <= 2000, `${name}: the rest of the budget`);
    const warn = entries.find((e) => e.msg === "food agent provider fallback");
    assert.ok(warn && warn.level === "warn", name);
    assert.equal(warn.meta.from, "deepseek-flash");
    assert.equal(warn.meta.to, "gpt-4o");
    assert.deepEqual(p.stats, { primaryCalls: 1, primaryFailures: 1, fallbackCalls: 1, authFailures: 0 });
  }
});

test("TIMEOUT: a primary that never answers is cut at its share; GPT-4o still answers inside the turn budget", async () => {
  const primary = new FakeProvider("deepseek-flash", () => new Promise(() => {}));
  const fallback = new FakeProvider("gpt-4o", () => final());
  const p = new FallbackProvider({ primary, fallback, primaryTimeoutShare: 0.5, minFallbackMs: 50 });
  const t0 = Date.now();
  const res = await p.respond(req(undefined, 400));
  const took = Date.now() - t0;
  assert.equal(res.text, '{"reply":"Dạ","items":[]}');
  assert.ok(took >= 190 && took < 400, `took ${took}ms`);
  assert.ok(fallback.calls[0].timeoutMs <= 210);
});

test("NO TIME LEFT: when the primary used the budget, its own error surfaces (the concierge falls back to FOOD's reply)", async () => {
  let clock = 0;
  const primary = new FakeProvider("deepseek-flash", () => {
    clock += 1900;
    throw new OpenAIProviderError("http", "DeepSeek HTTP 500", 500);
  });
  const fallback = new FakeProvider("gpt-4o", () => final());
  const p = new FallbackProvider({ primary, fallback, now: () => clock });
  await assert.rejects(p.respond(req()), (e) => e.status === 500);
  assert.equal(fallback.calls.length, 0);
});

test("401/403: logged as a configuration error, the fallback answers, and the primary is skipped for the cool-down — never a retry loop", async () => {
  for (const status of [401, 403]) {
    let clock = 0;
    const { entries, logger } = logs();
    const primary = new FakeProvider("deepseek-flash", fail("http", status));
    const fallback = new FakeProvider("gpt-4o", () => final());
    const p = new FallbackProvider({ primary, fallback, logger, authCooldownMs: 60_000, now: () => clock });
    await p.respond(req());
    const error = entries.find((e) => e.level === "error");
    assert.match(error.msg, /authentication\/configuration error/);
    assert.equal(error.meta.status, status);
    assert.equal(error.meta.model, "deepseek-flash");
    assert.ok(!JSON.stringify(entries).includes("CUSTOMER"), "no transcript in logs");
    // during the cool-down: many turns, no DeepSeek call
    for (let i = 0; i < 5; i += 1) {
      clock += 10_000;
      await p.respond(req([{ role: "user", content: `turn ${i}` }]));
    }
    assert.equal(primary.calls.length, 1, "one attempt in the window");
    assert.equal(fallback.calls.length, 6);
    // after the cool-down: exactly one new attempt
    clock += 20_000;
    await p.respond(req([{ role: "user", content: "later" }]));
    assert.equal(primary.calls.length, 2);
    assert.equal(p.stats.authFailures, 2);
  }
});

test("401 WITHOUT a fallback: the error is logged and surfaces; nothing is retried", async () => {
  const { entries, logger } = logs();
  const primary = new FakeProvider("deepseek-flash", fail("http", 401));
  const p = new FallbackProvider({ primary, fallback: null, logger });
  await assert.rejects(p.respond(req()), (e) => e.status === 401);
  assert.equal(primary.calls.length, 1);
  assert.ok(entries.some((e) => e.level === "error"));
});

test("CONFIGURATION: no DeepSeek key -> GPT-4o alone; no OpenAI key -> DeepSeek alone; neither -> not configured", async () => {
  const off = (model) => Object.assign(new FakeProvider(model, () => final()), { configured: false });
  const onlyFallback = new FallbackProvider({ primary: off("deepseek-flash"), fallback: new FakeProvider("gpt-4o", () => final()) });
  assert.equal(onlyFallback.model, "gpt-4o");
  await onlyFallback.respond(req());
  assert.equal(onlyFallback.primary.calls.length, 0);
  assert.equal(onlyFallback.fallback.calls.length, 1);
  const onlyPrimary = new FallbackProvider({ primary: new FakeProvider("deepseek-flash", () => final()), fallback: off("gpt-4o") });
  assert.equal(onlyPrimary.model, "deepseek-flash");
  await onlyPrimary.respond(req());
  assert.equal(onlyPrimary.primary.calls[0].timeoutMs, 2000, "no fallback: the primary gets the whole budget");
  assert.equal(new FallbackProvider({ primary: off("a"), fallback: off("b") }).configured, false);
});

test("TRANSCRIPT: DeepSeek items are made portable in a COPY for GPT-4o; the concierge's transcript is never changed", async () => {
  // round 1 (DeepSeek): reasoning + a tool call; round 2 (DeepSeek) fails -> GPT-4o
  const primary = new FakeProvider("deepseek-flash", (r, n) => {
    if (n === 1) {
      const output = [
        { type: "reasoning", id: "rs_ds1", content: [{ type: "reasoning_text", text: "thinking" }] },
        { type: "function_call", id: "fc_ds1", call_id: "call_ds1", name: "search_food", arguments: '{"query":"phở"}', status: "completed" },
      ];
      return { id: "r1", output, functionCalls: [{ callId: "call_ds1", name: "search_food", arguments: '{"query":"phở"}' }], text: "", usage: null };
    }
    throw new OpenAIProviderError("http", "DeepSeek HTTP 502", 502);
  });
  const fallback = new FakeProvider("gpt-4o", () => final());
  const p = new FallbackProvider({ primary, fallback });
  const input = [{ role: "user", content: "CUSTOMER: phở" }];
  const first = await p.respond(req(input));
  // the concierge appends the output and the tool result, as GptFoodConcierge does
  input.push(...first.output);
  input.push({ type: "function_call_output", call_id: "call_ds1", output: '{"results":[]}' });
  const before = structuredClone(input);
  await p.respond(req(input));
  assert.deepEqual(input, before, "the original transcript is not mutated");
  assert.equal(input[1].type, "reasoning", "the concierge still holds DeepSeek's own items");
  assert.deepEqual(fallback.calls[0].input, [
    { role: "user", content: "CUSTOMER: phở" },
    { type: "function_call", call_id: "call_ds1", name: "search_food", arguments: '{"query":"phở"}' },
    { type: "function_call_output", call_id: "call_ds1", output: '{"results":[]}' },
  ]);
  // DeepSeek -> DeepSeek: its own items are sent back untouched
  assert.equal(primary.calls[1].input[1].type, "reasoning");
  assert.equal(primary.calls[1].input[2].id, "fc_ds1");
});

test("TRANSCRIPT: an assistant message from DeepSeek (Fact Guard retry) reaches GPT-4o as plain assistant text", async () => {
  const primary = new FakeProvider("deepseek-flash", (r, n) => (n === 1 ? final('{"reply":"giá 99.000đ","items":[]}') : fail("timeout")()));
  const fallback = new FakeProvider("gpt-4o", () => final());
  const p = new FallbackProvider({ primary, fallback });
  const input = [{ role: "user", content: "CUSTOMER: bún bò" }];
  const first = await p.respond(req(input));
  input.push(...first.output, { role: "user", content: "FACT_GUARD_REJECTED: ..." });
  await p.respond(req(input));
  assert.deepEqual(fallback.calls[0].input, [
    { role: "user", content: "CUSTOMER: bún bò" },
    { role: "assistant", content: '{"reply":"giá 99.000đ","items":[]}' },
    { role: "user", content: "FACT_GUARD_REJECTED: ..." },
  ]);
});

test("STICKY PER TURN: after a fallback, the rest of that turn goes straight to GPT-4o; the next turn tries DeepSeek again", async () => {
  const primary = new FakeProvider("deepseek-flash", fail("timeout"));
  const fallback = new FakeProvider("gpt-4o", () => final());
  const p = new FallbackProvider({ primary, fallback });
  const input = [{ role: "user", content: "turn A" }];
  await p.respond(req(input));
  input.push({ type: "function_call_output", call_id: "x", output: "{}" });
  await p.respond(req(input));
  await p.respond(req(input));
  assert.equal(primary.calls.length, 1, "no second wait on a slow primary in the same turn");
  assert.equal(fallback.calls.length, 3);
  await p.respond(req([{ role: "user", content: "turn B" }]));
  assert.equal(primary.calls.length, 2);
});
