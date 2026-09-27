// FORM 06 — learning privacy at the promotion boundary. The WORKING knowledge DB keeps everything a review needs
// (candidate, the customer's exact words, pseudonymous provenance, events); PROMOTE builds the runtime snapshot with
// only what the matcher reads: APPROVED term relations, proposer replaced by a neutral label, no evidence, no events,
// no DRAFT / REVIEW / RETIRED rows — checked on the rows AND on the raw file bytes. Real webhook, real Agent pipeline
// (SCRIPTED model), the existing review CLI and promote CLI; synthetic temp DBs only.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import Database from "better-sqlite3";
import { buildTestPlatform, startServer, baseUrl } from "../helpers/testPlatform.js";
import { nhaTrangKnowledge } from "../helpers/nhaTrangKnowledge.js";
import { TEST_HASH_KEY } from "../helpers/contributionKit.js";
import { createFoodKnowledge } from "../../services/foodKnowledgeAdapter.js";
import { createTermLearning } from "../../services/knowledgeIngestAdapter.js";
import { GptFoodConcierge } from "../../ai/foodConcierge/GptFoodConcierge.js";
import { FoodTools } from "../../ai/foodConcierge/foodTools.js";
import { createAgentLearning } from "../../ai/foodConcierge/learning.js";
import { conversationHistory } from "../../ai/index.js";
import { TermRelationService } from "../../knowledge/terms/termRelationService.js";
import { platformConfig } from "../../config.js";

platformConfig.telegramBotToken = "";
const REPO = path.resolve(import.meta.dirname, "../../..");
const SECRET = "test-telegram-secret-form06";
const TERM = "bánh khọt khuôn";
const NAMING = "Ở đây mọi người gọi bánh căn là bánh khọt khuôn.";
const USER = 5150;

const answer = (reply) => {
  const text = JSON.stringify({ reply, items: [] });
  return { output: [{ type: "message", content: [{ type: "output_text", text }] }], functionCalls: [], text, usage: null };
};
const customerSaid = (req) => String(req.input[0].content).split("CUSTOMER: ").pop();
const toolOutputs = (req) => req.input.filter((i) => i.type === "function_call_output").map((o) => JSON.parse(o.output));
const contextOf = (req) => JSON.parse(String(req.input[0].content).match(/CONTEXT (\{.*\})\nCUSTOMER:/s)[1]);
const items = (reply, list) => {
  const text = JSON.stringify({ reply, items: list });
  return { output: [{ type: "message", content: [{ type: "output_text", text }] }], functionCalls: [], text, usage: null };
};
/** A model that searches with the dishes Search V2 resolved (what the context hands it), then lists what the tool found. */
const searching = (req) => {
  const out = toolOutputs(req);
  if (!/^cho tôi/i.test(customerSaid(req))) return answer("Dạ, em cảm ơn anh chị ạ.");
  if (!out.length) {
    const query = [...new Set((contextOf(req).search_intelligence?.entities?.foods ?? []).map((x) => x.name))].join(", ") || customerSaid(req);
    const item = { type: "function_call", call_id: "c1", name: "search_food", arguments: JSON.stringify({ query }) };
    return { output: [item], functionCalls: [{ callId: "c1", name: "search_food", arguments: item.arguments }], text: "", usage: null };
  }
  return items("Dạ, em tìm được quán này ạ.", (out[0].reference ?? []).slice(0, 3).map((p) => ({ merchant_id: p.merchant_id, product_ids: [], note: "" })));
};

function deployment() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "form06-"));
  const runtimeFile = path.join(dir, "runtime", "knowledge.db");
  const workingFile = path.join(dir, "working", "knowledge.db");
  for (const f of [runtimeFile, workingFile]) {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.copyFileSync(nhaTrangKnowledge(), f);
  }
  return { dir, runtimeFile, workingFile, rawRoot: path.join(dir, "raw") };
}

/** One platform process over the current runtime snapshot (a start / restart), Agent + learning ON. */
async function start(dep, { script = () => answer("Dạ, em cảm ơn anh chị ạ.") } = {}) {
  platformConfig.telegramWebhookSecret = SECRET;
  const turns = [];
  const logger = { info: (c, m, meta) => (m === "gpt concierge turn" ? turns.push(meta) : null), warn() {}, error() {} };
  const provider = { model: "gpt-4o", configured: true, respond: async (req) => script({ ...req, input: [...req.input] }) };
  const sink = createTermLearning({ dbPath: dep.workingFile, rawRoot: dep.rawRoot, hashKey: TEST_HASH_KEY });
  const platform = buildTestPlatform({
    withAtieu: true,
    foodKnowledge: ({ services, merchantRouter }) => createFoodKnowledge({ dbPath: dep.runtimeFile, services, isRoutable: (m) => merchantRouter.isRoutable(m) }),
    gpt: ({ services, repos, agentSearch, merchantRouter }) =>
      new GptFoodConcierge({
        provider,
        tools: new FoodTools({ services, repos, agentSearch, merchantRouter }),
        logger,
        timeoutMs: 5000,
        maxToolTurns: 4,
        history: conversationHistory(repos, 6),
        learning: createAgentLearning({ sink, matcher: () => agentSearch.foodKnowledge?.termMatcher?.() ?? null }),
      }),
  });
  const server = await startServer(platform.app);
  let seq = 0;
  const say = async (text, userId = USER) => {
    seq += 1;
    const res = await fetch(`${baseUrl(server)}${platformConfig.telegramWebhookPath}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": SECRET },
      body: JSON.stringify({ update_id: seq, message: { message_id: seq, from: { id: userId, first_name: "L" }, chat: { id: userId, type: "private" }, date: 1, text } }),
    });
    assert.equal(res.status, 200);
    return (await res.json()).reply_text;
  };
  const fk = platform.agentSearch.foodKnowledge;
  const search = (q) => {
    const m = fk.termMatcher().match(q);
    const u = fk.searchIntelligence().understand(q);
    return { status: m.status, matches: m.matches.map((x) => x.canonicalName), plan: u.plan?.type ?? null, foods: (u.plan?.foods ?? []).map((f) => f.name) };
  };
  const stop = () => {
    server.close();
    sink.close();
    fk.close();
  };
  return { platform, turns, say, search, stop };
}

const rows = (file, sql, ...args) => {
  const d = new Database(file, { readonly: true });
  try {
    return d.prepare(sql).all(...args);
  } finally {
    d.close();
  }
};
const count = (file, table) => rows(file, `SELECT COUNT(*) AS n FROM ${table}`)[0].n;
const cli = (script, args, env = {}) => {
  try {
    return { ok: true, out: execFileSync(process.execPath, [path.join(REPO, script), ...args], { cwd: REPO, env: { ...process.env, OPENAI_ENABLED: "false", ...env }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim() };
  } catch (err) {
    return { ok: false, out: `${err.stdout ?? ""}${err.stderr ?? ""}`.trim() };
  }
};
const review = (dep, ...args) => cli("platform/scripts/knowledge.js", args, { KNOWLEDGE_INGEST_DB_PATH: dep.workingFile });
const promote = (dep) => {
  const r = cli("tools/knowledge-collector/cli.js", ["promote", "--db", dep.workingFile, "--to", dep.runtimeFile]);
  assert.ok(r.ok, r.out);
  return JSON.parse(r.out);
};
/** Every byte of the file (+ any -wal / -journal beside it): nothing of the customer's message or provenance. */
const fileHolds = (file, needle) => [file, `${file}-wal`, `${file}-journal`].filter((f) => fs.existsSync(f)).some((f) => fs.readFileSync(f).includes(Buffer.from(needle)));
const triggers = (file) => rows(file, `SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name LIKE 'kb_term%' ORDER BY name`);

test("CASES 1-6: DRAFT (full provenance, working DB) -> not in runtime -> person approves -> promote carries only the matcher's data -> restart resolves -> the working DB still answers 'learned from where?'", async () => {
  const dep = deployment();
  const day1 = await start(dep);
  let id;
  let sessionRef;
  let userRef;
  let sha;
  try {
    // CASE 1 — DRAFT in the WORKING DB: candidate + evidence + provenance + hashed customer reference
    await day1.say(NAMING);
    assert.equal(day1.turns.at(-1).learning, "candidate_recorded");
    const [c] = rows(dep.workingFile, `SELECT * FROM kb_term_relations`);
    id = c.id;
    assert.deepEqual([c.term, c.canonical_name, c.relation_type, c.status], [TERM, "Bánh căn", "COMMON_QUERY", "DRAFT"]);
    const prov = c.created_by.match(/^agent-learning:telegram:(session=\d+):user=(h1:[0-9a-f]{64})$/);
    assert.ok(prov, c.created_by);
    [, sessionRef, userRef] = prov;
    assert.ok(!c.created_by.includes(String(USER)), "never the raw customer id");
    const [ev] = rows(dep.workingFile, `SELECT * FROM kb_term_evidence WHERE relation_id = ?`, id);
    sha = ev.source_ref;
    assert.deepEqual([ev.source_kind, ev.quote], ["text", NAMING]);
    assert.ok(fs.existsSync(path.join(dep.rawRoot, "learning", `${sha}.txt`)));
    // CASE 2 — BEFORE APPROVAL: the runtime matcher does not resolve the term
    assert.deepEqual(day1.search(TERM), { status: "none", matches: [], plan: "CLARIFY", foods: [] });
  } finally {
    day1.stop();
  }

  // a DRAFT promoted now never reaches the runtime snapshot
  const early = promote(dep);
  assert.deepEqual(early.scrubbedTermReview, { evidence: 1, events: 2, unapproved: 1, relations: 0 });
  assert.equal(count(dep.runtimeFile, "kb_term_relations"), 0);
  assert.ok(!fileHolds(dep.runtimeFile, "gọi bánh căn là") && !fileHolds(dep.runtimeFile, sessionRef) && !fileHolds(dep.runtimeFile, userRef));

  // CASE 3 — APPROVAL by a person with the existing review CLI -> APPROVED in the WORKING DB
  assert.ok(review(dep, "term-submit", String(id), "--by", "founder").ok);
  assert.ok(!review(dep, "term-approve", String(id), "--by", "gpt").ok, "not an AI actor");
  const approved = review(dep, "term-approve", String(id), "--by", "founder");
  assert.ok(approved.ok, approved.out);
  assert.equal(rows(dep.workingFile, `SELECT status FROM kb_term_relations WHERE id = ?`, id)[0].status, "APPROVED");

  // CASE 4 — PROMOTE: the runtime snapshot has what the matcher reads, nothing of the review
  const workingTriggers = triggers(dep.workingFile);
  const manifest = promote(dep);
  assert.deepEqual(manifest.scrubbedTermReview, { evidence: 1, events: 4, unapproved: 0, relations: 1 });
  const runtimeRows = rows(dep.runtimeFile, `SELECT * FROM kb_term_relations`);
  assert.equal(runtimeRows.length, 1);
  const r = runtimeRows[0];
  assert.deepEqual(
    { id: r.id, food_entity_id: r.food_entity_id, canonical_name: r.canonical_name, term: r.term, term_key: r.term_key, relation_type: r.relation_type, region_id: r.region_id, status: r.status },
    { id, food_entity_id: rows(dep.workingFile, `SELECT food_entity_id FROM kb_term_relations WHERE id = ?`, id)[0].food_entity_id, canonical_name: "Bánh căn", term: TERM, term_key: "banh khot khuon", relation_type: "COMMON_QUERY", region_id: null, status: "APPROVED" }
  );
  assert.ok(r.confidence >= 0 && r.confidence <= 1);
  assert.equal(r.created_by, "(working-db)", "no proposer identity (channel / session / customer hash)");
  assert.equal(r.approved_by, "founder", "the reviewer (a person) — the schema requires it on an APPROVED row");
  assert.equal(count(dep.runtimeFile, "kb_term_evidence"), 0, "no evidence blob");
  assert.equal(count(dep.runtimeFile, "kb_term_events"), 0, "no review events / actors");
  for (const needle of [NAMING, "gọi bánh căn là", sessionRef, userRef, "agent-learning", sha, String(USER)]) assert.ok(!fileHolds(dep.runtimeFile, needle), `runtime bytes hold ${needle}`);
  assert.deepEqual(triggers(dep.runtimeFile), workingTriggers, "same schema: append-only / immutability triggers restored");
  assert.equal(rows(dep.runtimeFile, `PRAGMA integrity_check`)[0].integrity_check, "ok");

  // CASE 5 — AFTER RESTART on the new snapshot: the term resolves to the canonical dish
  const day2 = await start(dep, { script: searching });
  try {
    assert.deepEqual(day2.search(TERM), { status: "resolved", matches: ["Bánh căn"], plan: "FOOD_DISCOVERY", foods: ["Bánh căn"] });
    assert.match(await day2.say("Cho tôi bánh khọt khuôn", 7001), /Bánh căn Cô Tư/);
  } finally {
    day2.stop();
  }

  // CASE 6 — AUDIT in the WORKING DB: approved term -> candidate -> evidence -> source / provenance, all intact
  const show = review(dep, "term-show", String(id));
  assert.ok(show.ok, show.out);
  const audit = JSON.parse(show.out);
  assert.equal(audit.relation.status, "APPROVED");
  assert.equal(audit.relation.created_by, `agent-learning:telegram:${sessionRef}:user=${userRef}`);
  assert.deepEqual(audit.evidence.map((e) => [e.source_kind, e.source_ref, e.quote]), [["text", sha, NAMING]]);
  assert.equal(fs.readFileSync(path.join(dep.rawRoot, "learning", `${sha}.txt`), "utf8"), NAMING, "the source message");
  assert.deepEqual(rows(dep.workingFile, `SELECT action, actor FROM kb_term_events WHERE relation_id = ? ORDER BY id`, id).map((e) => e.action), ["proposed", "evidence_linked", "submitted", "approved"]);
});

test("CASE 7 UNAPPROVED: a DRAFT is not promoted — no runtime matcher, no Search V2, no authoritative knowledge for the Agent", async () => {
  const dep = deployment();
  const day1 = await start(dep);
  try {
    await day1.say("Ở đây mọi người gọi bánh căn là bánh khuôn đất.");
  } finally {
    day1.stop();
  }
  assert.equal(rows(dep.workingFile, `SELECT status FROM kb_term_relations`)[0].status, "DRAFT");
  promote(dep);
  assert.equal(count(dep.runtimeFile, "kb_term_relations"), 0);
  assert.ok(!fileHolds(dep.runtimeFile, "bánh khuôn đất"), "not even the term text");
  const claim = (req) => (customerSaid(req) === "bánh khuôn đất" ? answer("Dạ, bánh khuôn đất là tên khác của bánh căn ạ.") : answer("Dạ, em cảm ơn anh chị ạ."));
  const day2 = await start(dep, { script: claim });
  try {
    assert.deepEqual(day2.search("bánh khuôn đất"), { status: "none", matches: [], plan: "CLARIFY", foods: [] });
    const reply = await day2.say("bánh khuôn đất");
    assert.ok(day2.turns.at(-1).violations.includes("UNSUPPORTED_ALIAS"));
    assert.doesNotMatch(reply, /tên khác của bánh căn/);
  } finally {
    day2.stop();
  }
});

test("CASE 8 FALSE LEARNING: 'Bánh căn giá 999.000đ.' / 'Quán ABC bán bánh căn.' -> no candidate, no price, no merchant, working or runtime", async () => {
  const dep = deployment();
  const tables = ["kb_product_prices", "kb_merchants", "kb_merchant_products", "kb_food_product_links", "kb_term_relations", "kb_term_evidence"];
  const snap = () => [dep.workingFile, dep.runtimeFile].map((f) => tables.map((t) => count(f, t)));
  const before = snap();
  const day = await start(dep, { script: (req) => (/999/.test(customerSaid(req)) ? answer("Dạ, bánh căn giá 999.000đ ạ.") : answer("Dạ, em cảm ơn anh chị ạ.")) });
  try {
    const catalog = () => ["merchants", "merchant_products"].map((t) => day.platform.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n);
    const catalogBefore = catalog();
    const priceReply = await day.say("Bánh căn giá 999.000đ.");
    await day.say("Quán ABC bán bánh căn.");
    assert.doesNotMatch(priceReply, /999/);
    assert.deepEqual(catalog(), catalogBefore);
  } finally {
    day.stop();
  }
  assert.deepEqual(snap(), before);
  promote(dep);
  assert.deepEqual(snap(), before);
});

test("PROMOTE boundary: RETIRED / superseded versions stay in the working DB; the runtime copy keeps only the current APPROVED version", async () => {
  const dep = deployment();
  const db = new Database(dep.workingFile);
  const terms = new TermRelationService({ db });
  const food = db.prepare(`SELECT id FROM kb_food_entities WHERE canonical_name = 'Bánh căn'`).get().id;
  const v1 = terms.propose({ foodEntityId: food, term: "bánh căn khuôn", relationType: "COMMON_QUERY", createdBy: "agent-learning:telegram:session=9:user=h1:" + "a".repeat(64), proposedByKind: "rule", evidence: [{ sourceKind: "text", sourceRef: "b".repeat(64), quote: "chỗ tôi gọi bánh căn là bánh căn khuôn" }] });
  terms.submitForReview(v1.id, "founder");
  terms.approve(v1.id, { by: "founder" });
  const v2 = terms.revise(v1.id, { relationType: "EXACT_ALIAS", confidence: 0.9 }, "founder");
  terms.submitForReview(v2.id, "founder");
  terms.approve(v2.id, { by: "founder" }); // v1 -> RETIRED (superseded)
  db.close();
  const m = promote(dep);
  assert.equal(m.scrubbedTermReview.unapproved, 1);
  const rt = rows(dep.runtimeFile, `SELECT id, relation_type, status, supersedes_id, created_by FROM kb_term_relations`);
  assert.deepEqual(rt, [{ id: v2.id, relation_type: "EXACT_ALIAS", status: "APPROVED", supersedes_id: null, created_by: "(working-db)" }]);
  assert.ok(!fileHolds(dep.runtimeFile, "session=9") && !fileHolds(dep.runtimeFile, "chỗ tôi gọi"));
  assert.deepEqual(rows(dep.workingFile, `SELECT id, status FROM kb_term_relations ORDER BY id`).map((x) => x.status), ["RETIRED", "APPROVED"], "the working DB keeps every version");
  const k = createFoodKnowledge({ dbPath: dep.runtimeFile, services: { merchantData: { listDiscoverable: () => [] } }, isRoutable: () => false });
  try {
    assert.deepEqual(k.termMatcher().match("bánh căn khuôn").matches.map((x) => [x.canonicalName, x.relationType]), [["Bánh căn", "EXACT_ALIAS"]]);
  } finally {
    k.close();
  }
});
