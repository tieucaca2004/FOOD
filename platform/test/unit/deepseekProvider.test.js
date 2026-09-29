// DeepSeekProvider against a FAKE fetch — no network, no real key. The request is the Responses API request of
// OpenAIProvider without `include`, with json_schema sent as json_object; tool calls and the final answer are
// checked here, and anything malformed is an `invalid_response` (a provider failure the fallback acts on).
import { test } from "node:test";
import assert from "node:assert/strict";
import { DeepSeekProvider, schemaErrors } from "../../ai/deepseek/DeepSeekProvider.js";
import { OpenAIProviderError } from "../../ai/openai/OpenAIProvider.js";
import { ANSWER_FORMAT } from "../../ai/foodConcierge/systemPrompt.js";

const FAKE_KEY = "sk-deepseek-FAKE-not-a-real-key";
const TOOLS = [{ type: "function", name: "search_food", description: "d", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false } }];

function provider(respond, seen = []) {
  const fetchImpl = async (url, init) => {
    seen.push({ url, init, body: JSON.parse(init.body) });
    const out = await respond();
    if (out instanceof Error) throw out;
    return typeof out.status === "number" ? out : { ok: true, status: 200, json: async () => out };
  };
  return new DeepSeekProvider({ apiKey: FAKE_KEY, model: "deepseek-flash", baseUrl: "https://deepseek.test/", fetchImpl });
}
const message = (text) => ({ id: "resp_ds", output: [{ type: "message", id: "msg_ds", role: "assistant", content: [{ type: "output_text", text }] }], usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } });
const call = (fields) => ({ id: "resp_ds", output: [{ type: "function_call", id: "fc_ds", ...fields }] });
const VALID = JSON.stringify({ reply: "Dạ", items: [{ merchant_id: "cat:ATIEU001", product_ids: ["catp:ATIEU001:1"], note: "" }] });
const req = { instructions: "INSTRUCTIONS", input: [{ role: "user", content: "hi" }], tools: TOOLS, format: ANSWER_FORMAT, timeoutMs: 1000 };

test("DEEPSEEK REQUEST: Responses API at the configured base URL, DeepSeek key and model, no include, json_object + the schema in the instructions", async () => {
  const seen = [];
  const p = provider(() => message(VALID), seen);
  assert.equal(p.model, "deepseek-flash");
  assert.equal(p.configured, true);
  const res = await p.respond(req);
  const { url, init, body } = seen[0];
  assert.equal(url, "https://deepseek.test/responses");
  assert.equal(init.headers.authorization, `Bearer ${FAKE_KEY}`);
  assert.equal(body.model, "deepseek-flash");
  assert.equal("include" in body, false, "no reasoning.encrypted_content for DeepSeek");
  assert.deepEqual(body.text, { format: { type: "json_object" } }, "strict json_schema is not relied on");
  assert.ok(body.instructions.startsWith("INSTRUCTIONS"));
  assert.ok(body.instructions.includes(JSON.stringify(ANSWER_FORMAT.schema)), "the schema is stated for json_object mode");
  assert.deepEqual(body.tools, TOOLS, "tool definitions unchanged");
  assert.equal(body.tool_choice, "auto");
  assert.deepEqual(body.input, req.input, "transcript unchanged");
  assert.equal(res.text, VALID);
  assert.deepEqual(res.usage, { input_tokens: 3, output_tokens: 2, total_tokens: 5 });
});

test("DEEPSEEK: without a key or model it is not configured and never calls out", async () => {
  let called = false;
  const p = new DeepSeekProvider({ apiKey: "", model: "deepseek-flash", baseUrl: "https://deepseek.test", fetchImpl: async () => (called = true) });
  assert.equal(p.configured, false);
  assert.equal(new DeepSeekProvider({ apiKey: FAKE_KEY, model: "", baseUrl: "https://deepseek.test" }).configured, false);
  await assert.rejects(p.respond(req), (e) => e.kind === "not_configured" && /DeepSeek/.test(e.message));
  assert.equal(called, false);
});

test("DEEPSEEK TOOL CALLS: a well-formed function_call passes through; missing call_id / name or non-object arguments are invalid_response", async () => {
  const good = await provider(() => call({ call_id: "call_1", name: "search_food", arguments: '{"query":"phở"}' })).respond(req);
  assert.deepEqual(good.functionCalls, [{ callId: "call_1", name: "search_food", arguments: '{"query":"phở"}' }]);
  for (const bad of [
    { name: "search_food", arguments: "{}" },
    { call_id: "", name: "search_food", arguments: "{}" },
    { call_id: "call_1", arguments: "{}" },
    { call_id: "call_1", name: "search_food", arguments: "{not json" },
    { call_id: "call_1", name: "search_food", arguments: "[1,2]" },
    { call_id: "call_1", name: "search_food", arguments: "null" },
  ]) {
    await assert.rejects(provider(() => call(bad)).respond(req), (e) => e instanceof OpenAIProviderError && e.kind === "invalid_response", JSON.stringify(bad));
  }
});

test("DEEPSEEK FINAL ANSWER: not JSON, or not the schema's shape, is invalid_response (checked before the Fact Guard)", async () => {
  for (const text of [
    "Dạ, em chào anh/chị",
    "",
    JSON.stringify({ reply: "Dạ" }),
    JSON.stringify({ reply: 1, items: [] }),
    JSON.stringify({ reply: "Dạ", items: [null] }),
    JSON.stringify({ reply: "Dạ", items: [{ merchant_id: "cat:A", product_ids: ["x"] }] }),
    JSON.stringify({ reply: "Dạ", items: [{ merchant_id: "cat:A", product_ids: [1], note: "" }] }),
    JSON.stringify({ reply: "Dạ", items: [], extra: true }),
  ]) {
    await assert.rejects(provider(() => message(text)).respond(req), (e) => e.kind === "invalid_response", text);
  }
  const ok = await provider(() => message(JSON.stringify({ reply: "Dạ", items: [] }))).respond(req);
  assert.equal(ok.text, JSON.stringify({ reply: "Dạ", items: [] }));
});

test("DEEPSEEK ERRORS: status and kind are kept for the fallback policy; messages name DeepSeek, never the key", async () => {
  const cases = [
    [{ ok: false, status: 401, json: async () => ({}) }, "http", 401],
    [{ ok: false, status: 403, json: async () => ({}) }, "http", 403],
    [{ ok: false, status: 429, json: async () => ({}) }, "rate_limit", 429],
    [{ ok: false, status: 503, json: async () => ({}) }, "http", 503],
    [{ ok: false, status: 400, json: async () => ({}) }, "http", 400],
    [new Error("ECONNRESET"), "network", null],
  ];
  for (const [answer, kind, status] of cases) {
    await assert.rejects(provider(() => answer).respond(req), (e) => {
      assert.equal(e.kind, kind);
      assert.equal(e.status, status);
      assert.match(e.message, /DeepSeek/);
      assert.ok(!e.message.includes(FAKE_KEY));
      return true;
    });
  }
});

test("schemaErrors: the JSON-schema subset of FOOD's answer format", () => {
  const schema = ANSWER_FORMAT.schema;
  assert.deepEqual(schemaErrors(schema, { reply: "a", items: [] }), []);
  assert.deepEqual(schemaErrors(schema, { reply: "a", items: [{ merchant_id: "m", product_ids: [], note: "" }] }), []);
  assert.deepEqual(schemaErrors(schema, []), ["$ must be an object"]);
  assert.deepEqual(schemaErrors(schema, { reply: "a", items: [{ merchant_id: "m", product_ids: [], note: "", x: 1 }] }), ["$.items[0].x is not allowed"]);
  assert.deepEqual(schemaErrors({ type: "integer" }, 1.5), ["$ must be an integer"]);
  assert.deepEqual(schemaErrors({ type: "boolean" }, "true"), ["$ must be a boolean"]);
});
