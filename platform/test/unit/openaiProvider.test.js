// OpenAIProvider against a FAKE fetch — no network, no real key. Checks the Responses API
// request shape, parsing, error kinds, and that the key never leaks into errors.
import { test } from "node:test";
import assert from "node:assert/strict";
import { OpenAIProvider, OpenAIProviderError } from "../../ai/openai/OpenAIProvider.js";

const FAKE_KEY = "sk-test-FAKE-not-a-real-key";
const ok = (body) => async () => ({ ok: true, status: 200, json: async () => body });

test("OPENAI PROVIDER: stateless Responses API request; tool calls and text parsed", async () => {
  let seen;
  const fetchImpl = async (url, init) => {
    seen = { url, init, body: JSON.parse(init.body) };
    return ok({
      id: "resp_1",
      output: [
        { type: "reasoning", id: "rs_1", encrypted_content: "x" },
        { type: "function_call", call_id: "call_1", name: "search_food", arguments: '{"query":"phở"}' },
        { type: "message", content: [{ type: "output_text", text: "{\"reply\":\"ok\",\"items\":[]}" }] },
      ],
      usage: { input_tokens: 1 },
    })();
  };
  const p = new OpenAIProvider({ apiKey: FAKE_KEY, model: "configured-model", baseUrl: "https://example.test/v1/", fetchImpl });
  const tools = [{ type: "function", name: "search_food", parameters: { type: "object", properties: {} } }];
  const format = { type: "json_schema", name: "x", schema: {} };
  const r = await p.respond({ instructions: "I", input: [{ role: "user", content: "hi" }], tools, format, timeoutMs: 1000 });
  assert.equal(seen.url, "https://example.test/v1/responses");
  assert.equal(seen.init.headers.authorization, `Bearer ${FAKE_KEY}`);
  assert.equal(seen.body.model, "configured-model"); // from config, never hard-coded
  assert.equal(seen.body.store, false);
  assert.deepEqual(seen.body.tools, tools);
  assert.equal(seen.body.tool_choice, "auto");
  assert.deepEqual(seen.body.text, { format });
  assert.deepEqual(seen.body.include, ["reasoning.encrypted_content"]);
  assert.deepEqual(r.functionCalls, [{ callId: "call_1", name: "search_food", arguments: '{"query":"phở"}' }]);
  assert.equal(r.text, "{\"reply\":\"ok\",\"items\":[]}");
  assert.equal(r.output.length, 3); // echoed back between tool rounds
});

test("OPENAI PROVIDER: not configured without key or model; error kinds never carry the key", async () => {
  assert.equal(new OpenAIProvider({ apiKey: "", model: "m" }).configured, false);
  assert.equal(new OpenAIProvider({ apiKey: FAKE_KEY, model: "" }).configured, false);
  await assert.rejects(new OpenAIProvider({ apiKey: "", model: "" }).respond({ instructions: "", input: [], timeoutMs: 10 }), (e) => e.kind === "not_configured");
  const cases = [
    [async () => ({ ok: false, status: 429, json: async () => ({}) }), "rate_limit"],
    [async () => ({ ok: false, status: 500, json: async () => ({}) }), "http"],
    [async () => ({ ok: true, status: 200, json: async () => ({ nope: 1 }) }), "invalid_response"],
    [async () => ({ ok: true, status: 200, json: async () => { throw new Error("bad"); } }), "invalid_response"],
    [async () => { throw new Error("ECONNRESET"); }, "network"],
    [(url, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })))), "timeout"],
  ];
  for (const [fetchImpl, kind] of cases) {
    const p = new OpenAIProvider({ apiKey: FAKE_KEY, model: "m", fetchImpl });
    await assert.rejects(p.respond({ instructions: "", input: [], timeoutMs: 20 }), (e) => {
      assert.ok(e instanceof OpenAIProviderError);
      assert.equal(e.kind, kind);
      assert.ok(!String(e.message).includes(FAKE_KEY));
      return true;
    });
  }
});
