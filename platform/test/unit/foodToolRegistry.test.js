// FoodAIToolRegistry: the model reaches FOOD only through registered tools with validated arguments.
// Also a static boundary check: the GPT layer holds no SQL / shell / filesystem / HTTP / eval path.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FoodAIToolRegistry, createFoodToolRegistry, validateArgs } from "../../ai/foodConcierge/toolRegistry.js";

const schema = {
  type: "object",
  properties: { query: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 10 }, max_price: { type: "number" } },
  required: ["query"],
  additionalProperties: false,
};

test("REGISTRY: registered tools only; definitions expose schema, never the handler", async () => {
  let ran = 0;
  const r = new FoodAIToolRegistry().register({ name: "search_food", description: "d", inputSchema: schema, handler: async (args) => (ran++, { data: { echo: args }, facts: [] }) });
  assert.deepEqual(r.definitions(), [{ type: "function", name: "search_food", description: "d", parameters: schema }]);
  assert.deepEqual(await r.execute("search_food", { query: "phở" }, {}), { ok: true, data: { echo: { query: "phở" } }, facts: [] });
  const unknown = await r.execute("run_sql", { sql: "SELECT 1" }, {});
  assert.deepEqual([unknown.ok, unknown.error.code], [false, "UNKNOWN_TOOL"]);
  assert.equal(ran, 1);
  assert.throws(() => r.register({ name: "search_food", description: "", inputSchema: schema, handler: () => {} }), /already registered/);
  assert.throws(() => r.register({ name: "Bad Name!", description: "", inputSchema: schema, handler: () => {} }), /invalid tool name/);
});

test("REGISTRY: invalid arguments are rejected before any handler runs", async () => {
  let ran = 0;
  const r = new FoodAIToolRegistry().register({ name: "search_food", description: "d", inputSchema: schema, handler: async () => (ran++, { data: {}, facts: [] }) });
  for (const args of [undefined, null, [], "phở", {}, { query: "" }, { query: 42 }, { query: "x", limit: 0 }, { query: "x", limit: 2.5 }, { query: "x", limit: 99 }, { query: "x", max_price: "50k" }, { query: "x", sql: "DROP TABLE" }, { query: "x".repeat(501) }]) {
    const out = await r.execute("search_food", args, {});
    assert.equal(out.ok, false, JSON.stringify(args));
    assert.equal(out.error.code, "INVALID_ARGUMENTS");
    assert.equal(out.data.error, "INVALID_ARGUMENTS"); // what the model is told
  }
  assert.equal(ran, 0);
  assert.deepEqual(validateArgs(schema, { query: "x", limit: 3 }), []);
});

test("REGISTRY: a handler failure is a structured TOOL_FAILED — its detail never reaches the model", async () => {
  const r = new FoodAIToolRegistry().register({ name: "get_menu", description: "d", inputSchema: { type: "object", properties: {}, additionalProperties: false }, handler: async () => { throw new Error("SQLITE_BUSY at D:/FOOD/data/secret.db"); } });
  const out = await r.execute("get_menu", {}, {});
  assert.deepEqual([out.ok, out.error.code], [false, "TOOL_FAILED"]);
  assert.doesNotMatch(JSON.stringify(out), /SQLITE|secret\.db/);
});

test("FOOD REGISTRY: exactly the read-only FOOD tools, nothing that writes or reaches outside", () => {
  const names = createFoodToolRegistry({ run: async () => ({ data: {}, facts: [] }) }).definitions().map((d) => d.name).sort();
  assert.deepEqual(names, ["get_customer_cart", "get_menu", "get_merchant", "get_previous_knowledge_results", "get_product", "search_food", "search_merchants"]);
  // the session is bound by the backend, never chosen by the model
  const defs = Object.fromEntries(createFoodToolRegistry({ run: async () => ({}) }).definitions().map((d) => [d.name, d.parameters]));
  assert.deepEqual(defs.get_previous_knowledge_results.properties, {});
  assert.deepEqual(defs.get_customer_cart.properties, {});
});

test("GPT BOUNDARY (static): the GPT layer has no SQL, shell, filesystem, HTTP (other than the provider) or eval path", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../ai");
  const files = ["foodConcierge/GptFoodConcierge.js", "foodConcierge/toolRegistry.js", "foodConcierge/foodTools.js", "foodConcierge/factGuard.js", "foodConcierge/systemPrompt.js", "openai/OpenAIProvider.js"];
  for (const f of files) {
    const src = fs.readFileSync(path.join(root, f), "utf8");
    assert.doesNotMatch(src, /better-sqlite3|\.prepare\(|node:child_process|node:fs|node:http|node:net|\beval\(|new Function|\brequire\(/, f);
    assert.doesNotMatch(src, /from ["'][^"']*\/knowledge\//, `${f} imports the knowledge layer directly`);
    if (!f.startsWith("openai/")) assert.doesNotMatch(src, /\bfetch\(/, `${f} makes HTTP calls`);
  }
  // no key or environment variable is ever put into what the model receives
  const prompt = fs.readFileSync(path.join(root, "foodConcierge/systemPrompt.js"), "utf8") + fs.readFileSync(path.join(root, "foodConcierge/GptFoodConcierge.js"), "utf8");
  assert.doesNotMatch(prompt, /process\.env|apiKey|OPENAI_API_KEY|authorization/i);
});
