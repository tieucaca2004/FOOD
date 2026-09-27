// PHASE B boundary: Search Intelligence V2 (platform/search/v2) is the ONE query reader at runtime. The earlier
// reader (platform/search/searchIntent.js, "V1") may remain for its own implementation tests / benchmark until they
// are re-expressed against V2, but no runtime module may import it — the GPT concierge must never get a second,
// parallel reading of a message.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PLATFORM = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function runtimeFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "test" || e.name === "node_modules") continue;
      out.push(...runtimeFiles(p));
    } else if (e.name.endsWith(".js")) out.push(p);
  }
  return out;
}

test("no runtime module imports Search Intelligence V1 (platform/search/searchIntent.js)", () => {
  const offenders = runtimeFiles(PLATFORM).filter((f) => /from\s+["'][^"']*search\/searchIntent\.js["']|import\(\s*["'][^"']*search\/searchIntent\.js/.test(fs.readFileSync(f, "utf8")));
  assert.deepEqual(offenders.map((f) => path.relative(PLATFORM, f)), []);
});

test("the GPT concierge and its tools read messages through Search Intelligence V2 only", () => {
  const concierge = fs.readFileSync(path.join(PLATFORM, "ai/foodConcierge/GptFoodConcierge.js"), "utf8");
  const layers = fs.readFileSync(path.join(PLATFORM, "ai/foodConcierge/knowledgeLayers.js"), "utf8");
  const tools = fs.readFileSync(path.join(PLATFORM, "ai/foodConcierge/foodTools.js"), "utf8");
  assert.match(concierge, /search\/v2\/index\.js/);
  assert.match(tools, /searchIntelligence\?\.\(\)/);
  for (const src of [concierge, layers, tools]) assert.doesNotMatch(src, /search_intent\s*=|context\.search_intent/);
});
