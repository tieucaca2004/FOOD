// Food Intelligence P0 — architecture boundaries, enforced by test:
//   - platform/knowledge depends on nothing of the ordering platform
//     (no repositories, services, merchant adapters, router, catalog);
//   - nothing in production imports it yet (P0: not wired into AgentSearch,
//     the ordering engine, the server or Telegram);
//   - its schema holds no merchant / menu / order tables.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PLATFORM = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const REPO = path.resolve(PLATFORM, "..");
const KNOWLEDGE = path.join(PLATFORM, "knowledge");

function jsFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === "node_modules" ? [] : jsFiles(p);
    return e.name.endsWith(".js") ? [p] : [];
  });
}

function imports(file) {
  const src = fs.readFileSync(file, "utf8");
  return [...src.matchAll(/(?:import\s[^"']*?from\s*|import\s*\(\s*|import\s+)["']([^"']+)["']/g)].map((m) => m[1]);
}

test("BOUNDARY: the knowledge layer imports nothing from the ordering platform", () => {
  const allowedOutside = new Set([path.join(REPO, "src", "nlp", "normalize.js")]);
  for (const file of jsFiles(KNOWLEDGE)) {
    for (const spec of imports(file)) {
      if (spec.startsWith("node:") || spec === "better-sqlite3") continue;
      assert.ok(spec.startsWith("."), `${path.relative(REPO, file)} imports package "${spec}"`);
      const target = path.resolve(path.dirname(file), spec);
      const inside = target.startsWith(KNOWLEDGE + path.sep);
      assert.ok(inside || allowedOutside.has(target), `${path.relative(REPO, file)} imports ${path.relative(REPO, target)}`);
    }
  }
});

test("BOUNDARY: only the read-only adapter, the ingestion bridge and the learning connector touch the knowledge layer; server.js only loads the bridges lazily", () => {
  // the ONLY production files allowed to import platform/knowledge
  // (knowledgeIngestAdapter.js: Knowledge Group ingestion, founder-requested 2026-09-26 — writes the WORKING DB, review only)
  const allowed = new Set([
    path.join(PLATFORM, "services", "foodKnowledgeAdapter.js"),
    path.join(PLATFORM, "services", "knowledgeIngestAdapter.js"),
    path.join(PLATFORM, "services", "semanticLearningService.js"),
    path.join(PLATFORM, "scripts", "knowledge.js"),
  ]);
  const production = [...jsFiles(PLATFORM), ...jsFiles(path.join(REPO, "src"))].filter(
    (f) => !f.startsWith(KNOWLEDGE + path.sep) && !f.startsWith(path.join(PLATFORM, "test") + path.sep) && !allowed.has(f)
  );
  for (const file of production) {
    for (const spec of imports(file)) {
      const target = spec.startsWith(".") ? path.resolve(path.dirname(file), spec) : spec;
      assert.ok(!String(target).startsWith(KNOWLEDGE), `${path.relative(REPO, file)} imports the knowledge layer`);
      // the adapter itself may only be loaded dynamically (behind the flag), never as a static import
      const src = fs.readFileSync(file, "utf8");
      assert.doesNotMatch(src, /^import[^;]*foodKnowledgeAdapter/m, `${path.relative(REPO, file)} statically imports the adapter`);
      assert.doesNotMatch(src, /^import[^;]*knowledgeIngestAdapter/m, `${path.relative(REPO, file)} statically imports the ingestion bridge`);
    }
  }
  // the learning connector only needs pure text helpers
  const learner = fs.readFileSync(path.join(PLATFORM, "services", "semanticLearningService.js"), "utf8");
  assert.deepEqual([...learner.matchAll(/from "(\.\.\/knowledge\/[^"]+)"/g)].map((m) => m[1]), ["../knowledge/text.js"]);
});

test("BOUNDARY: the knowledge schema never defines merchant, menu, cart or order data", () => {
  const dir = path.join(KNOWLEDGE, "migrations");
  for (const f of fs.readdirSync(dir)) {
    const sql = fs.readFileSync(path.join(dir, f), "utf8").replace(/--.*$/gm, ""); // statements only, not comments
    const created = [...sql.matchAll(/CREATE\s+(?:TABLE|VIEW)\s+IF\s+NOT\s+EXISTS\s+(\w+)/gi)].map((m) => m[1]);
    assert.ok(created.length > 0);
    for (const name of created) assert.match(name, /^kb_/, `${f}: ${name} is not a kb_ table`);
    assert.doesNotMatch(sql, /\b(merchant_products|merchant_categories|merchant_menus|merchants|orders|order_items|merchant_carts)\b/i, f);
  }
});

test("BOUNDARY: the knowledge DB defaults to its own file, never the platform DB", async () => {
  const { DEFAULT_KNOWLEDGE_DB_PATH } = await import("../../knowledge/db.js");
  assert.doesNotMatch(DEFAULT_KNOWLEDGE_DB_PATH, /platform\.db|atieu\.db/);
});
