// FORM 05 — the FOOD Agent learning loop, end to end, with the mechanisms that exist (nothing new):
//   customer says a new term (real webhook, real Agent pipeline, SCRIPTED model)
//   -> Agent OBSERVE -> one DRAFT term relation in the WORKING knowledge DB
//   -> a person reviews it with the review CLI (node platform/scripts/knowledge.js term-submit / term-approve)
//   -> the collector's promote CLI (node tools/knowledge-collector/cli.js promote) snapshots working -> runtime
//   -> the platform (re)starts on the new snapshot -> the NEXT interaction's matcher / Search V2 / Agent read the term.
// SYNTHETIC knowledge in temp files only; never the production DBs, never the real API.
// "Learning" here is approved interaction-derived knowledge in a persistent store — not model training.
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
import { platformConfig } from "../../config.js";

platformConfig.telegramBotToken = "";
const REPO = path.resolve(import.meta.dirname, "../../..");
const SECRET = "test-telegram-secret-form05";
const TERM = "bánh khọt khuôn";
const NAMING = "Ở đây mọi người gọi bánh căn là bánh khọt khuôn.";
const PLACE = "Bánh căn Cô Tư"; // the synthetic place that serves the canonical dish
const EVIDENCE_DIR = process.env.FORM05_EVIDENCE_DIR || null; // optional: where BEFORE / AFTER outputs are kept

const evidence = {};
const keep = (name, value) => {
  evidence[name] = value;
  if (EVIDENCE_DIR) {
    fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
    fs.writeFileSync(path.join(EVIDENCE_DIR, "learning_loop_evidence.json"), JSON.stringify(evidence, null, 2));
  }
};

const answer = (reply, items = []) => {
  const text = JSON.stringify({ reply, items });
  return { output: [{ type: "message", content: [{ type: "output_text", text }] }], functionCalls: [], text, usage: null };
};
let callSeq = 0;
const call = (name, args) => {
  const id = `c${++callSeq}`;
  const item = { type: "function_call", call_id: id, name, arguments: JSON.stringify(args) };
  return { output: [item], functionCalls: [{ callId: id, name, arguments: item.arguments }], text: "", usage: null };
};
const customerSaid = (req) => String(req.input[0].content).split("CUSTOMER: ").pop();
const toolOutputs = (req) => req.input.filter((i) => i.type === "function_call_output").map((o) => JSON.parse(o.output));
const contextOf = (req) => JSON.parse(String(req.input[0].content).match(/CONTEXT (\{.*\})\nCUSTOMER:/s)[1]);

class ScriptedProvider {
  constructor(script) {
    this.script = script ?? (() => answer("Dạ, em chưa rõ món này ạ."));
    this.model = "gpt-4o";
    this.configured = true;
    this.calls = [];
  }
  async respond(req) {
    const snap = { ...req, input: [...req.input] };
    this.calls.push(snap);
    return this.script(snap, this.calls.length);
  }
}

/** Both knowledge files of one deployment: the runtime snapshot (read) and the working DB (candidates, review). */
function deployment() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "form05-"));
  const runtimeFile = path.join(dir, "runtime", "knowledge.db");
  const workingFile = path.join(dir, "working", "knowledge.db");
  fs.mkdirSync(path.dirname(runtimeFile), { recursive: true });
  fs.mkdirSync(path.dirname(workingFile), { recursive: true });
  fs.copyFileSync(nhaTrangKnowledge(), runtimeFile);
  fs.copyFileSync(nhaTrangKnowledge(), workingFile);
  return { dir, runtimeFile, workingFile, rawRoot: path.join(dir, "raw") };
}

/** One run of the platform process over the CURRENT runtime snapshot (a start / restart), Agent + learning ON. */
async function start(dep, { script } = {}) {
  platformConfig.telegramWebhookSecret = SECRET;
  const provider = new ScriptedProvider(script);
  const turns = [];
  const logger = { info: (c, m, meta) => (m === "gpt concierge turn" ? turns.push(meta) : null), warn() {}, error() {} };
  const sink = createTermLearning({ dbPath: dep.workingFile, rawRoot: dep.rawRoot, hashKey: TEST_HASH_KEY });
  let agent = null;
  const platform = buildTestPlatform({
    withAtieu: true,
    foodKnowledge: ({ services, merchantRouter }) => createFoodKnowledge({ dbPath: dep.runtimeFile, services, isRoutable: (m) => merchantRouter.isRoutable(m) }),
    gpt: ({ services, repos, agentSearch, merchantRouter }) =>
      (agent = new GptFoodConcierge({
        provider,
        tools: new FoodTools({ services, repos, agentSearch, merchantRouter }),
        logger,
        timeoutMs: 5000,
        maxToolTurns: 4,
        history: conversationHistory(repos, 6),
        learning: createAgentLearning({ sink, matcher: () => agentSearch.foodKnowledge?.termMatcher?.() ?? null }),
      })),
  });
  const server = await startServer(platform.app);
  let seq = 0;
  const say = async (text, userId = 5150) => {
    seq += 1;
    const res = await fetch(`${baseUrl(server)}${platformConfig.telegramWebhookPath}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": SECRET },
      body: JSON.stringify({ update_id: seq, message: { message_id: seq, from: { id: userId, first_name: "L" }, chat: { id: userId, type: "private" }, date: 1, text } }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, "processed");
    return body.reply_text;
  };
  const fk = platform.agentSearch.foodKnowledge;
  // what Search reads for a query in THIS process: the APPROVED-only matcher and the Search V2 plan
  const search = (q) => {
    const m = fk.termMatcher().match(q);
    const u = fk.searchIntelligence().understand(q);
    return { query: q, matcher: { status: m.status, matches: m.matches.map((x) => ({ canonicalName: x.canonicalName, relationType: x.relationType, text: x.text })) }, searchV2: { plan: u.plan?.type ?? null, foods: (u.plan?.foods ?? []).map((f) => ({ name: f.name, key: f.key, said: f.said ?? null })), confidence: u.confidence ?? null } };
  };
  const stop = () => {
    server.close();
    sink.close();
    fk.close(); // the process ends: its snapshot handle is released
  };
  return { platform, provider, turns, say, search, stop, agent: () => agent };
}

const rows = (file, sql, ...args) => {
  const d = new Database(file, { readonly: true });
  try {
    return d.prepare(sql).all(...args);
  } finally {
    d.close();
  }
};
const relations = (file) => rows(file, `SELECT r.*, (SELECT json_group_array(quote) FROM kb_term_evidence e WHERE e.relation_id = r.id) AS quotes FROM kb_term_relations r ORDER BY id`);
const count = (file, table) => rows(file, `SELECT COUNT(*) AS n FROM ${table}`)[0].n;

/** The existing human review tool, as a person runs it — on the WORKING DB of this deployment only. */
const reviewCli = (dep, ...args) => {
  try {
    const out = execFileSync(process.execPath, [path.join(REPO, "platform/scripts/knowledge.js"), ...args], { cwd: REPO, env: { ...process.env, KNOWLEDGE_INGEST_DB_PATH: dep.workingFile, OPENAI_ENABLED: "false" }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { ok: true, out: out.trim() };
  } catch (err) {
    return { ok: false, out: `${err.stdout ?? ""}${err.stderr ?? ""}`.trim() };
  }
};
/** The existing promotion (collector -> runtime snapshot), explicit paths of this deployment only. */
const promoteCli = (dep) => {
  try {
    const out = execFileSync(process.execPath, [path.join(REPO, "tools/knowledge-collector/cli.js"), "promote", "--db", dep.workingFile, "--to", dep.runtimeFile], { cwd: REPO, env: { ...process.env, OPENAI_ENABLED: "false" }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { ok: true, manifest: JSON.parse(out) };
  } catch (err) {
    return { ok: false, out: `${err.stdout ?? ""}${err.stderr ?? ""}`.trim() };
  }
};

test("LEARNING LOOP: new term today -> DRAFT -> person approves -> promote -> after restart the next interaction understands it", async () => {
  const dep = deployment();
  const agentScript = (req) => {
    const said = customerSaid(req);
    const out = toolOutputs(req);
    if (/khọt khuôn/.test(said) && /^cho tôi/i.test(said)) {
      // the Agent answers from the TOOL with what Search V2 read (never from its own idea of the word)
      if (!out.length) return call("search_food", { query: [...new Set((contextOf(req).search_intelligence?.entities?.foods ?? []).map((f) => f.name))].join(", ") || said });
      return answer("Dạ, em tìm được quán này ạ.", (out[0].reference ?? []).slice(0, 3).map((p) => ({ merchant_id: p.merchant_id, product_ids: [], note: "" })));
    }
    return answer("Dạ, em cảm ơn anh chị đã chia sẻ ạ.");
  };

  // ------------------------------------------------------------------ DAY 1 (today)
  const day1 = await start(dep, { script: agentScript });
  let draftId;
  try {
    // BEFORE: the same query, in the running process
    const before = day1.search(TERM);
    const beforeOrder = day1.search("Cho tôi bánh khọt khuôn");
    const beforeReply = await day1.say("Cho tôi bánh khọt khuôn", 7001);
    keep("1_before_approval", { search: before, searchOrderSentence: beforeOrder, webhookReply: beforeReply });
    assert.equal(before.matcher.status, "none");
    assert.deepEqual(before.searchV2.foods, []);
    assert.notEqual(before.searchV2.plan, "FOOD_DISCOVERY");
    assert.ok(!beforeReply.includes(PLACE), "before approval the term does not find the Bánh căn place");

    // the customer teaches the term, through the real webhook and the real Agent pipeline
    const calls0 = day1.provider.calls.length;
    await day1.say(NAMING);
    assert.ok(day1.provider.calls.length > calls0, "the Agent ran this turn");
    assert.equal(day1.turns.at(-1).learning, "candidate_recorded");
    assert.match(String(day1.provider.calls.at(-1).input[0].content), /"noted_for_review":true/);
    const r = relations(dep.workingFile);
    assert.equal(r.length, 1, "exactly one candidate");
    const c = r[0];
    draftId = c.id;
    assert.deepEqual([c.canonical_name, c.term, c.relation_type, c.status, c.proposed_by_kind, c.approved_by], ["Bánh căn", TERM, "COMMON_QUERY", "DRAFT", "rule", null]);
    assert.match(c.created_by, /^agent-learning:telegram:session=\d+:user=h1:[0-9a-f]{64}$/, "Agent-learning identity + session + hashed customer");
    assert.doesNotMatch(c.created_by, /5150/, "never the raw platform id");
    assert.deepEqual(JSON.parse(c.quotes), [NAMING.replace(/\s+/g, " ")], "the verbatim message is the evidence");
    const ev = rows(dep.workingFile, `SELECT source_kind, source_ref FROM kb_term_evidence WHERE relation_id = ?`, c.id)[0];
    assert.equal(ev.source_kind, "text");
    assert.equal(fs.readFileSync(path.join(dep.rawRoot, "learning", `${ev.source_ref}.txt`), "utf8"), NAMING.replace(/\s+/g, " "), "evidence = sha256 of the raw message file");
    assert.equal(count(dep.runtimeFile, "kb_term_relations"), 0, "the candidate is in the WORKING DB, not the runtime snapshot");
    assert.equal(day1.search(TERM).matcher.status, "none", "and the runtime matcher does not know it");
    keep("2_draft_candidate", { id: c.id, canonical: c.canonical_name, term: c.term, relationType: c.relation_type, status: c.status, proposedByKind: c.proposed_by_kind, createdBy: c.created_by.replace(/h1:[0-9a-f]{64}/, "h1:<64-hex>"), evidence: { sourceKind: ev.source_kind, sha256: ev.source_ref, quote: JSON.parse(c.quotes)[0] }, db: "working" });

    // HUMAN REVIEW with the existing CLI: the Agent's store cannot approve; non-person actors are refused
    const agentStore = createTermLearning({ dbPath: dep.workingFile, rawRoot: dep.rawRoot });
    assert.deepEqual(Object.keys(agentStore).sort(), ["close", "propose"], "the Agent can only propose");
    agentStore.close();
    assert.ok(!day1.agent().registry.definitions().some((d) => /approve|publish|review|term|learn/i.test(d.name)), "no model tool approves or publishes");
    const submit = reviewCli(dep, "term-submit", String(c.id), "--by", "founder");
    assert.ok(submit.ok, submit.out);
    const refused = Object.fromEntries(["gpt", "gpt-4o", "ai", "bot", "system"].map((by) => [by, reviewCli(dep, "term-approve", String(c.id), "--by", by)]));
    for (const [by, res] of Object.entries(refused)) assert.ok(!res.ok && /person/i.test(res.out), `${by}: ${res.out}`);
    assert.equal(relations(dep.workingFile)[0].status, "REVIEW", "a refused approval changes nothing");
    const approve = reviewCli(dep, "term-approve", String(c.id), "--by", "founder");
    assert.ok(approve.ok, approve.out);
    const approved = relations(dep.workingFile)[0];
    assert.deepEqual([approved.status, approved.approved_by], ["APPROVED", "founder"]);
    keep("3_human_approval", { submit: submit.out, refusedActors: Object.fromEntries(Object.entries(refused).map(([k, v]) => [k, v.out.split("\n")[0]])), approve: approve.out, events: rows(dep.workingFile, `SELECT action, actor FROM kb_term_events WHERE relation_id = ? ORDER BY id`, c.id) });

    // approved in the working DB is not yet what the running platform reads
    const sameProcess = day1.search(TERM);
    assert.equal(sameProcess.matcher.status, "none", "the running process keeps its snapshot");
    const whileRunning = promoteCli(dep);
    // Windows refuses to replace a DB the platform holds open; elsewhere the old process still reads its old snapshot
    if (!whileRunning.ok) assert.match(whileRunning.out, /holding it open|EPERM|EBUSY/);
    assert.equal(day1.search(TERM).matcher.status, "none");
    keep("4_same_process_after_approval", { search: sameProcess, promoteWhileRunning: whileRunning.ok ? "replaced (old process keeps its snapshot)" : whileRunning.out.split(/\r?\n/).find((l) => /^Error: could not replace/.test(l.trim())) ?? whileRunning.out.slice(0, 200) });
  } finally {
    day1.stop();
  }

  // ------------------------------------------------------------------ PROMOTE (process stopped) + DAY 2 (restart)
  const promoted = promoteCli(dep);
  assert.ok(promoted.ok, promoted.out);
  const day2 = await start(dep, { script: agentScript });
  try {
    const after = day2.search(TERM);
    const afterOrder = day2.search("Cho tôi bánh khọt khuôn");
    assert.equal(after.matcher.status, "resolved");
    assert.deepEqual(after.matcher.matches, [{ canonicalName: "Bánh căn", relationType: "COMMON_QUERY", text: TERM }]);
    assert.equal(after.searchV2.plan, "FOOD_DISCOVERY");
    assert.deepEqual(after.searchV2.foods.map((f) => [f.name, f.key]), [["Bánh căn", "banh-can"]], "the authoritative entity is still the canonical dish");
    assert.deepEqual(afterOrder.searchV2.foods.map((f) => f.name), ["Bánh căn"]);
    const calls0 = day2.provider.calls.length;
    const reply = await day2.say("Cho tôi bánh khọt khuôn", 7001);
    const modelCalls = day2.provider.calls.length - calls0;
    assert.ok(reply.includes(PLACE), `the next interaction finds the canonical dish's place: ${reply.slice(0, 300)}`);
    // the Agent ran that turn and was handed Search V2's reading: the approved term, resolved to the canonical dish
    const turnCalls = day2.provider.calls.slice(calls0);
    const agentSawForOrder = turnCalls.length ? contextOf(turnCalls[0]).search_intelligence ?? null : null;
    const agentSearched = turnCalls.flatMap((c) => c.input.filter((i) => i.type === "function_call").map((i) => [i.name, JSON.parse(i.arguments)]));
    if (turnCalls.length) {
      assert.ok(agentSawForOrder.entities.foods.some((x) => x.name === "Bánh căn" && x.said === TERM && x.match_type === "APPROVED_ALIAS"), JSON.stringify(agentSawForOrder.entities));
      assert.deepEqual(agentSearched.find(([n]) => n === "search_food")?.[1]?.query, "Bánh căn");
    }
    // the Agent's own view reads the same approved term: the naming statement now teaches nothing new
    const again = await day2.say(NAMING, 5152);
    const agentTurn = day2.turns.at(-1);
    assert.equal(agentTurn.learning, "ALREADY_KNOWN");
    assert.equal(relations(dep.workingFile).length, 1, "no new candidate");
    keep("5_after_approval_and_restart", {
      promote: { sha256: promoted.manifest.sha256, counts: promoted.manifest.counts },
      search: after,
      searchOrderSentence: afterOrder,
      webhookReply: reply,
      modelCallsForThatReply: modelCalls,
      agentLearningOnRepeat: agentTurn.learning,
      agentSearchIntelligenceEntities: agentSawForOrder?.entities?.foods ?? null,
      agentToolCalls: agentSearched,
      agentReplyOnRepeat: again,
    });
  } finally {
    day2.stop();
  }
});

test("UNAPPROVED: a second term stays a DRAFT -> not in the matcher / Search V2 even after promotion; the Agent may not call it an alias", async () => {
  const dep = deployment();
  const TERM2 = "bánh khuôn đất";
  const claim = (req) => (customerSaid(req) === TERM2 ? answer("Dạ, bánh khuôn đất là tên khác của bánh căn ạ.") : answer("Dạ, em cảm ơn anh chị ạ."));
  // what the term reads as when NO candidate exists anywhere (the control)
  const control = await start(deployment(), { script: claim });
  const controlSearch = control.search(TERM2);
  control.stop();
  const day1 = await start(dep, { script: claim });
  const literalX = {};
  try {
    // the form's literal "bánh X": Search V2 (frozen) reads the capital X as a proper name -> UNKNOWN_PLACE, answered
    // deterministically; the Agent is not called, so nothing is observed (recorded as the current behaviour)
    for (const t of ["Ở đây bánh căn còn gọi là bánh X.", "Ở đây mọi người gọi bánh căn là bánh X."]) {
      const n0 = day1.provider.calls.length;
      const reply = await day1.say(t);
      literalX[t] = { searchV2Plan: day1.platform.agentSearch.foodKnowledge.searchIntelligence().understand(t).plan?.type, agentCalled: day1.provider.calls.length > n0, candidates: relations(dep.workingFile).length, reply: reply.slice(0, 160) };
      assert.equal(literalX[t].candidates, 0);
    }
    // a real second term reaches the Agent -> a DRAFT, which nobody approves
    await day1.say("Ở đây mọi người gọi bánh căn là bánh khuôn đất.");
    const r = relations(dep.workingFile);
    assert.deepEqual(r.map((x) => [x.term, x.canonical_name, x.status]), [[TERM2, "Bánh căn", "DRAFT"]]);
  } finally {
    day1.stop();
  }
  assert.ok(promoteCli(dep).ok); // FORM 06: a DRAFT never reaches the runtime snapshot (it stays in the working DB)
  assert.deepEqual([count(dep.runtimeFile, "kb_term_relations"), count(dep.workingFile, "kb_term_relations")], [0, 1]);
  const day2 = await start(dep, { script: claim });
  try {
    const s = day2.search(TERM2);
    assert.equal(s.matcher.status, "none");
    assert.deepEqual(s.searchV2.foods, []);
    assert.deepEqual(s, controlSearch, "Search reads the term exactly as if the candidate did not exist");
    const t0 = day2.turns.length;
    const reply = await day2.say(TERM2);
    const t = day2.turns.slice(t0).at(-1);
    assert.ok(t, "the Agent answered this turn");
    assert.ok(t.violations.includes("UNSUPPORTED_ALIAS"), JSON.stringify(t.violations));
    assert.equal(t.mode, "deterministic_fallback");
    assert.doesNotMatch(reply, /tên khác của bánh căn/i);
    keep("6_unapproved", { literalBanhX: literalX, candidate: TERM2 + " -> Bánh căn (DRAFT, kept in the working DB, not promoted)", search: s, controlSearchWithoutCandidate: controlSearch, agentClaimed: "Dạ, bánh khuôn đất là tên khác của bánh căn ạ.", factGuard: t.violations, mode: t.mode, customerSaw: reply });
  } finally {
    day2.stop();
  }
});

test("FALSE LEARNING: a customer's price or 'quán ABC bán …' never becomes a candidate, a price, a place or a link; Fact Guard keeps the authoritative price", async () => {
  const dep = deployment();
  const priceClaim = (req) => (/999/.test(customerSaid(req)) ? answer("Dạ, bánh căn ở đây giá 999.000đ ạ.") : answer("Dạ, em cảm ơn anh chị ạ."));
  const day = await start(dep, { script: priceClaim });
  try {
    const tables = ["kb_product_prices", "kb_merchants", "kb_merchant_products", "kb_food_product_links", "kb_food_names", "kb_term_relations"];
    const snap = () => ({
      runtime: Object.fromEntries(tables.map((t) => [t, count(dep.runtimeFile, t)])),
      working: Object.fromEntries(tables.map((t) => [t, count(dep.workingFile, t)])),
      catalog: ["merchants", "merchant_products"].map((t) => day.platform.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n),
    });
    const before = snap();
    const priceReply = await day.say("Bánh căn ở đây giá 999.000đ.");
    const priceTurn = day.turns.at(-1);
    await day.say("Quán ABC bán bánh căn.");
    assert.deepEqual(snap(), before, "nothing written anywhere");
    assert.equal(relations(dep.workingFile).length, 0);
    assert.doesNotMatch(priceReply, /999/);
    if (priceTurn) assert.equal(priceTurn.mode, "deterministic_fallback", JSON.stringify(priceTurn.violations));
    keep("7_false_learning", { countsBeforeAndAfter: before, priceReply, priceTurn: priceTurn ? { mode: priceTurn.mode, violations: priceTurn.violations, learning: priceTurn.learning ?? null } : "not routed to the Agent" });
  } finally {
    day.stop();
  }
});

test("REPEATED: the same naming statement 3x -> one candidate, one evidence (same text); another customer's wording adds evidence", async () => {
  const dep = deployment();
  const day = await start(dep);
  try {
    const same = "Ở đây gọi bánh căn là bánh khọt khuôn.";
    const outcomes = [];
    for (let i = 0; i < 3; i += 1) {
      await day.say(same);
      outcomes.push(day.turns.at(-1).learning);
    }
    let r = relations(dep.workingFile);
    assert.equal(r.length, 1);
    assert.equal(JSON.parse(r[0].quotes).length, 1, "identical text = identical evidence (sha256), linked once");
    await day.say("chỗ tôi hay gọi bánh căn là bánh khọt khuôn", 6060);
    r = relations(dep.workingFile);
    assert.equal(r.length, 1);
    assert.equal(JSON.parse(r[0].quotes).length, 2);
    assert.equal(r[0].status, "DRAFT", "repetition never promotes anything");
    keep("8_repeated", { outcomes, relations: r.length, evidenceQuotes: JSON.parse(r[0].quotes), status: r[0].status });
  } finally {
    day.stop();
  }
});

test("CONVERSATION MEMORY: 'quán thứ 2' is understood from the conversation, but the place always comes from stored results / a TOOL — never from HISTORY", async () => {
  const dep = deployment();
  let secondId = null;
  let historyOnly = false;
  const script = (req) => {
    const said = customerSaid(req);
    const out = toolOutputs(req);
    if (said === "Cho tôi bún cá") {
      if (!out.length) return call("search_food", { query: "Bún cá" });
      return answer("Dạ, em tìm được các quán này.", out[0].reference.slice(0, 3).map((p) => ({ merchant_id: p.merchant_id, product_ids: [], note: "" })));
    }
    if (said === "quán thứ 2") {
      if (historyOnly) return answer("Dạ, quán thứ 2 đây ạ.", [{ merchant_id: secondId, product_ids: [], note: "" }]); // no tool this turn
      if (!out.length) return call("get_previous_knowledge_results", {});
      secondId = out[0].places[1].merchant_id;
      return answer("Dạ, quán thứ 2 đây ạ.", [{ merchant_id: secondId, product_ids: [], note: "" }]);
    }
    return answer("Dạ, em cảm ơn anh chị ạ.");
  };
  const day = await start(dep, { script });
  try {
    const USER = 4242;
    const list = await day.say("Cho tôi bún cá", USER);
    const names = [...list.matchAll(/📍 ([^\n]+)|• ([^—\n]+) —/g)].map((m) => (m[1] ?? m[2]).trim());
    assert.ok(names.length >= 2, list.slice(0, 300));
    // (a) the real webhook: the follow-up is answered from the conversation's STORED list (knowledge context)
    const webhookReply = await day.say("quán thứ 2", USER);
    assert.ok(webhookReply.includes(names[1]), `2nd place (${names[1]}) -> ${webhookReply.slice(0, 200)}`);
    // (b) the Agent itself on the same session (as the router calls it): HISTORY from the stored messages to
    // understand "thứ 2"; the place from get_previous_knowledge_results (authoritative); rendered by the backend
    const customer = day.platform.repos.customers.findByZaloUserId(`telegram:${USER}`);
    const session = day.platform.repos.sessions.getActiveByCustomer(customer.id);
    const n0 = day.provider.calls.length;
    const viaTool = await day.agent().respond({ customer, session, text: "quán thứ 2", reason: "unknown" });
    const calls = day.provider.calls.slice(n0);
    assert.match(String(calls[0].input[0].content), /HISTORY[\s\S]*Khách: Cho tôi bún cá/, "the Agent saw the conversation");
    assert.ok(calls.some((c) => toolOutputs(c).some((o) => Array.isArray(o.places))), "the list came from get_previous_knowledge_results");
    assert.ok(viaTool?.text.includes(names[1]), JSON.stringify(viaTool?.text ?? null));
    assert.equal(viaTool.meta.mode, "gpt");
    // (c) the same place id, remembered from the conversation and answered WITHOUT a tool this turn: refused
    historyOnly = true;
    const fromHistory = await day.agent().respond({ customer, session, text: "quán thứ 2", reason: "unknown" });
    assert.equal(fromHistory, null, "not an authoritative result -> the deterministic reply stands");
    const refusedTurn = day.turns.at(-1);
    keep("9_conversation_memory", { list: names.slice(0, 3), webhookFollowUp: webhookReply, agent: { historySeen: true, tools: viaTool.meta.tools.map((t) => t.toolName ?? t.name ?? t), reply: viaTool.text }, agentFromHistoryOnly: { mode: refusedTurn.mode, violations: refusedTurn.violations, fallbackReason: refusedTurn.fallbackReason ?? null } });
  } finally {
    day.stop();
  }
});
