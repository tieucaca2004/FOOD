// FORM 10 — follow-up context contract. A reference ("quán thứ 2", "quán đầu tiên", "quán đó", "món thứ 2",
// "giá món đó", "còn không?") is resolved DETERMINISTICALLY, before any model call, against the STRUCTURED context
// FOOD stored when it showed something (ids + timestamps, per session) — never against reply text or HISTORY.
// Precedence: an entity named in the message > an ordinal against the active enumerated list > the focus (the place /
// dish last answered about) > otherwise ask. A merchant detail answer ("Quán X có menu gì?") makes X the focus but
// does NOT replace the enumerated list the customer was shown before it. Ambiguous -> clarify, never guess.
// Real webhook, SCRIPTED model (Agent ON, so a model call would be visible), synthetic temp knowledge.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { buildTestPlatform, startServer, baseUrl } from "../helpers/testPlatform.js";
import { nhaTrangKnowledge } from "../helpers/nhaTrangKnowledge.js";
import { createFoodKnowledge } from "../../services/foodKnowledgeAdapter.js";
import { GptFoodConcierge } from "../../ai/foodConcierge/GptFoodConcierge.js";
import { FoodTools } from "../../ai/foodConcierge/foodTools.js";
import { conversationHistory } from "../../ai/index.js";
import { platformConfig } from "../../config.js";

platformConfig.telegramBotToken = "";
const SECRET = "test-telegram-secret-form10";
const LIST = /• ([^—\n]+) —/g;
const names = (reply) => [...String(reply).matchAll(LIST)].map((m) => m[1].trim());

/** the synthetic knowledge + a second "Bún Cá Mịn" (production has two such records) + a 3-dish menu */
function knowledge() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "form10-")), "knowledge.db");
  fs.copyFileSync(nhaTrangKnowledge(), file);
  const d = new Database(file);
  const ins = (sql, ...p) => d.prepare(sql).run(...p).lastInsertRowid;
  const ev = (q) => ins(`INSERT INTO kb_evidence (source_id, quote, extraction, verification) VALUES ((SELECT MIN(id) FROM kb_sources), ?, 'explicit', 'verified')`, q);
  const m = ins(`INSERT INTO kb_merchants (key, name, normalized_name, status, first_seen_at, last_seen_at) VALUES ('bun-ca-min-2', 'Bún Cá Mịn', 'bun ca min', 'candidate', '2026-09-26', '2026-09-26')`);
  ins(`INSERT INTO kb_merchant_locations (merchant_id, address_original, region_id, evidence_id, captured_at, last_seen_at, status) VALUES (?, '88 Trần Phú, Nha Trang', 'vn.khanh-hoa.nha-trang', ?, '2026-09-26', '2026-09-26', 'published')`, m, ev("88 Trần Phú"));
  ins(`INSERT INTO kb_merchant_products (merchant_id, original_name, normalized_name, evidence_id, status, first_seen_at, last_seen_at, observation) VALUES (?, 'Bún cá sứa', 'bun ca sua', ?, 'published', '2026-09-26', '2026-09-26', 'mention')`, m, ev("Bún cá sứa"));
  d.close();
  return file;
}

// default model: fails closed (invalid output) -> every list turn shows FOOD's deterministic list
async function start({ script = () => ({ output: [], functionCalls: [], text: "not json", usage: null }), genericFixtureMerchants = [] } = {}) {
  platformConfig.telegramWebhookSecret = SECRET;
  const calls = [];
  const provider = { model: "gpt-4o", configured: true, respond: async (req) => (calls.push({ ...req, input: [...req.input] }), script(req)) };
  const file = knowledge();
  const platform = buildTestPlatform({
    withAtieu: true,
    genericFixtureMerchants,
    foodKnowledge: ({ services, merchantRouter }) => createFoodKnowledge({ dbPath: file, services, isRoutable: (m) => merchantRouter.isRoutable(m) }),
    gpt: ({ services, repos, agentSearch, merchantRouter }) => new GptFoodConcierge({ provider, tools: new FoodTools({ services, repos, agentSearch, merchantRouter }), timeoutMs: 5000, maxToolTurns: 4, history: conversationHistory(repos, 6) }),
  });
  const server = await startServer(platform.app);
  let seq = 0;
  const say = async (text, user = 5000) => {
    seq += 1;
    const res = await fetch(`${baseUrl(server)}${platformConfig.telegramWebhookPath}`, { method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": SECRET }, body: JSON.stringify({ update_id: seq, message: { message_id: seq, from: { id: user, first_name: "L" }, chat: { id: user, type: "private" }, date: 1, text } }) });
    assert.equal(res.status, 200);
    return (await res.json()).reply_text;
  };
  const session = (user = 5000) => platform.repos.sessions.getActiveByCustomer(platform.repos.customers.findByZaloUserId(`telegram:${user}`).id);
  const context = (user = 5000) => platform.services.sessions.getKnowledgeContext(session(user).id);
  /** a follow-up: answered with NO model call (the resolver, not GPT, decides what the reference means) */
  const follow = async (text, user = 5000) => {
    const n = calls.length;
    const reply = await say(text, user);
    assert.equal(calls.length, n, `"${text}" must be resolved without the model`);
    return reply;
  };
  const stop = () => {
    server.close();
    platform.agentSearch.foodKnowledge.close();
  };
  return { platform, calls, say, follow, session, context, stop };
}

const LIST_A = "Cho tôi danh sách quán bán bún cá";

test("T1 / T5 / T6 / T7: ordinals resolve against the list shown; out of range is said, never invented", async () => {
  const d = await start();
  try {
    const a = names(await d.say(LIST_A));
    assert.ok(a.length >= 3, a.join(" | "));
    assert.ok(names(await d.follow("quán thứ 2"))[0] === a[1]);
    assert.ok(names(await d.follow("quán đầu tiên"))[0] === a[0]);
    assert.ok(names(await d.follow("quán thứ 3"))[0] === a[2]);
    assert.ok(names(await d.follow("cho tôi quán thứ 2 đi"))[0] === a[1]);
    const ten = await d.follow("quán thứ 10");
    assert.deepEqual(names(ten), []);
    assert.match(ten, new RegExp(`có ${a.length} quán`), ten);
  } finally {
    d.stop();
  }
});

test("T2: a turn that shows no new list keeps the list; FORM 09 case 3: a merchant detail in between does not replace it", async () => {
  const d = await start();
  try {
    const a = names(await d.say(LIST_A));
    await d.say("cảm ơn em");
    assert.equal(names(await d.follow("quán thứ 2"))[0], a[1]);
    // "Quán Bún cá Cô Ba có menu gì?" answers ONE named place: it becomes the focus, list A stays the list
    const menu = await d.say("Quán Bún cá Cô Ba có menu gì?");
    assert.match(menu, /Bún cá Cô Ba/);
    assert.equal(names(await d.follow("Cho tôi quán thứ 3."))[0], a[2], "the list the customer was shown");
    assert.equal(names(await d.follow("quán đó"))[0], a[2], "and the focus moves to what was just answered");
  } finally {
    d.stop();
  }
});

test("T3: a NEW list replaces the old one (latest shown list is the active reference)", async () => {
  const d = await start();
  try {
    await d.say(LIST_A);
    const b = names(await d.say("Cho tôi danh sách quán bán hủ tiếu"));
    assert.ok(b.length >= 2, b.join(" | "));
    assert.equal(names(await d.follow("quán thứ 2"))[0], b[1]);
  } finally {
    d.stop();
  }
});

test("T4: ambiguous references are asked back, never guessed", async () => {
  const d = await start({ genericFixtureMerchants: ["MERCHANT002", "MERCHANT003"] });
  try {
    const a = names(await d.say(LIST_A));
    assert.ok(a.length >= 3);
    // several places shown, none answered about yet: "quán đó" has no referent
    assert.match(await d.follow("quán đó"), /quán nào trong danh sách/);
    // a name matching TWO places: FOOD shows both — that is the list now (latest shown list), and "quán đó" is unclear
    const two = await d.say("Quán Bún Cá Mịn có menu gì?");
    assert.equal(names(two).length, 2, two);
    assert.match(await d.follow("quán đó"), /quán nào trong danh sách/);
    assert.equal(names(await d.follow("quán thứ 2"))[0], names(two)[1]);
    // TWO lists on screen at once (orderable catalog places + reference places), both with a #2: either could be meant.
    // The state is built in the real session stores (a catalog pick list + a shown reference list).
    await d.say(LIST_A, 5100);
    const sid = d.session(5100).id;
    d.platform.services.sessions.update(sid, { lastSearchResults: [{ merchant_id: "ATIEU001", name: "Hủ Tiếu Xào A Tiểu", name_match: false }, { merchant_id: "MERCHANT002", name: "Merchant 002 (Test Fixture)", name_match: false }] });
    const ask = await d.follow("cho tôi quán thứ 2", 5100);
    assert.match(ask, /quán thứ 2 trong danh sách đặt được qua FOOD \(Merchant 002 \(Test Fixture\)\) hay trong danh sách tham khảo \(Bún cá Cô Ba\)/, ask);
    assert.equal(d.session(5100).context, "platform", "nothing opened");
    // a bare number keeps its catalog meaning (the catalog prompt says "gõ số thứ tự")
    await d.say("2", 5100);
    assert.equal(d.session(5100).active_merchant_id, "MERCHANT002");
  } finally {
    d.stop();
  }
});

test("T8 / T9 / T12: 'món thứ 2' / 'món đó' resolve against the menu shown; the price comes from the data; nothing is added to a cart", async () => {
  const d = await start();
  try {
    const menu = await d.say("Quán Bún cá Cô Ba có menu gì?");
    const dishes = [...menu.matchAll(/– ([^:\n]+):/g)].map((m) => m[1].trim());
    assert.ok(dishes.length >= 3, menu);
    const second = await d.follow("món thứ 2");
    assert.match(second, new RegExp(dishes[1]));
    assert.doesNotMatch(second, new RegExp(`– ${dishes[0]}:`), "only that dish");
    const price = await d.follow("giá món đó bao nhiêu?");
    assert.match(price, new RegExp(`${dishes[1]}: giá tham khảo 15\\.000đ`), price);
    assert.doesNotMatch(price, /25\.000đ/, "not another dish's price");
    assert.match(await d.follow("món đầu tiên"), new RegExp(dishes[0]));
    const again = await d.follow("Cho tôi món thứ 2");
    assert.match(again, new RegExp(dishes[1]));
    assert.equal(d.session().context, "platform", "a reference place: no merchant opened, no cart");
    const out = await d.follow("món thứ 9");
    assert.match(out, /có 3 món/, out);
  } finally {
    d.stop();
  }
});

test("T10: 'còn không?' only about a clear referent; FOOD says what it does not know", async () => {
  const d = await start();
  try {
    await d.say(LIST_A);
    assert.match(await d.follow("còn không?"), /quán nào|món nào/, "no referent yet");
    const [second] = names(await d.follow("quán thứ 2"));
    const avail = await d.follow("còn không?");
    assert.match(avail, new RegExp(second));
    assert.match(avail, /chưa có thông tin/);
  } finally {
    d.stop();
  }
});

test("T11: catalog list -> 'Cho tôi quán thứ 2' opens that orderable place -> 'Cho 2 phần' goes to its own ordering flow", async () => {
  const d = await start({ genericFixtureMerchants: ["MERCHANT002"] });
  try {
    const found = await d.say("tìm hải sản");
    const listed = d.session().lastSearchResults.map((r) => r.merchant_id);
    assert.ok(listed.length >= 2, found);
    const opened = await d.follow("Cho tôi quán thứ 2");
    assert.equal(d.session().context, "merchant", opened);
    assert.equal(d.session().active_merchant_id, listed[1], opened);
    const order = await d.say("Cho 2 phần");
    assert.equal(d.session().active_merchant_id, listed[1], "the ordering flow of that merchant owns the turn");
    assert.ok(order.length > 0);
  } finally {
    d.stop();
  }
});

test("T13: a place mentioned only in HISTORY is not a referent and not a fact", async () => {
  const script = (req) => {
    const outputs = req.input.filter((i) => i.type === "function_call_output");
    // a model that would take the place from HISTORY: refused by the Fact Guard (no tool fact this turn)
    return { output: [], functionCalls: [], text: JSON.stringify({ reply: "Dạ, Quán ABC nổi tiếng ạ.", items: outputs.length ? [] : [{ merchant_id: "kb:999", product_ids: [], note: "" }] }), usage: null };
  };
  const d = await start({ script });
  try {
    await d.say(LIST_A);
    const s = d.session();
    d.platform.repos.messages.log({ sessionId: s.id, direction: "out", intent: null, rawText: "Quán ABC nổi tiếng với bún cá, ở 1 Trần Phú." });
    const r = await d.follow("quán đó");
    assert.doesNotMatch(r, /ABC/);
    const agent = await d.say("quán ABC ở đâu");
    assert.doesNotMatch(agent, /nổi tiếng|1 Trần Phú/, agent);
  } finally {
    d.stop();
  }
});

test("T14 / T15: an expired list is not used; another session never sees this one's list", async () => {
  const d = await start();
  try {
    await d.say(LIST_A, 7001);
    // another customer: nothing to refer to
    const other = await d.follow("quán thứ 2", 7002);
    assert.deepEqual(names(other), []);
    assert.doesNotMatch(other, /Bún cá Cô Ba|Bún cá Cam Ranh|Bún Cá Mẫu/);
    // this customer's list, expired
    const s = d.session(7001);
    d.platform.services.sessions.setKnowledgeContext(s.id, { ...d.context(7001), touchedAt: "2020-01-01T00:00:00.000Z" });
    const stale = await d.follow("quán thứ 2", 7001);
    assert.deepEqual(names(stale), [], stale);
    // an expired list kept under a merchant detail is not used either
    await d.say(LIST_A, 7003);
    await d.say("Quán Bún cá Cô Ba có menu gì?", 7003);
    const c = d.context(7003);
    if (c.list) d.platform.services.sessions.setKnowledgeContext(d.session(7003).id, { ...c, list: { ...c.list, touchedAt: "2020-01-01T00:00:00.000Z" } });
    const r = await d.follow("quán thứ 2", 7003);
    assert.doesNotMatch(r, /Bún cá Cam Ranh|Bún Cá Mẫu/, r);
  } finally {
    d.stop();
  }
});

test("T16 FORM 09 case 3: the Agent renders the answers — the reference is what IT showed (its order, its items), never a hidden record", async () => {
  const outs = (req) => req.input.filter((i) => i.type === "function_call_output").map((o) => JSON.parse(o.output));
  const said = (req) => String(req.input[0].content).split("CUSTOMER: ").pop();
  const ctxOf = (req) => JSON.parse(String(req.input[0].content).match(/CONTEXT (\{.*\})\nCUSTOMER:/s)[1]);
  let n = 0;
  const call = (name, args) => {
    const id = `c${++n}`;
    const item = { type: "function_call", call_id: id, name, arguments: JSON.stringify(args) };
    return { output: [item], functionCalls: [{ callId: id, name, arguments: item.arguments }], text: "", usage: null };
  };
  const answer = (items) => ({ output: [], functionCalls: [], text: JSON.stringify({ reply: "Dạ, em gửi anh chị ạ.", items }), usage: null });
  const script = (req) => {
    const o = outs(req);
    if (said(req) === LIST_A) {
      if (!o.length) return call("search_food", { query: "Bún cá" });
      return answer([...o[0].reference].reverse().slice(0, 3).map((p) => ({ merchant_id: p.merchant_id, product_ids: [], note: "" }))); // its own order
    }
    if (/Bún Cá Mịn/.test(said(req))) {
      if (!o.length) return call("search_merchants", { query: "Bún Cá Mịn" });
      const first = o[0].reference?.[0]?.merchant_id;
      return answer([{ merchant_id: first, product_ids: [], note: "" }]); // ONE of the two same-name records
    }
    return { output: [], functionCalls: [], text: "not json", usage: null };
  };
  const d = await start({ script });
  try {
    const shownA = [...(await d.say(LIST_A)).matchAll(/📍 ([^\n]+)/g)].map((m) => m[1].trim());
    assert.equal(shownA.length, 3, "the Agent rendered list A");
    assert.equal(d.calls.length > 0, true);
    const detail = await d.say("Quán Bún Cá Mịn có menu gì?");
    assert.equal([...detail.matchAll(/📍 /g)].length, 1, detail);
    const second = await d.follow("Cho tôi quán thứ 2.");
    assert.equal(names(second)[0], shownA[1], `the 2nd place of the list AS SHOWN (${shownA[1]}): ${second}`);
    assert.doesNotMatch(second, /Bún Cá Mịn/, "never the record the customer did not see");
  } finally {
    d.stop();
  }
});


test("T17: 'menu quán này' after 'quán thứ 2' shows THAT place's menu (from the data) -> 'món thứ 2' / 'giá món đó' follow it", async () => {
  const d = await start();
  try {
    const a = names(await d.say(LIST_A));
    const second = names(await d.follow("quán thứ 2"))[0];
    assert.equal(second, a[1]);
    const menu = await d.follow("Cho tôi menu quán này");
    assert.equal(names(menu)[0], second, menu);
    const dishes = [...menu.matchAll(/– ([^:\n]+):/g)].map((m) => m[1].trim());
    assert.ok(dishes.length >= 2, menu);
    assert.match(await d.follow("món thứ 2"), new RegExp(`– ${dishes[1]}:`));
    const price = await d.follow("giá món đó bao nhiêu?");
    assert.match(price, new RegExp(`– ${dishes[1]}:`));
    assert.doesNotMatch(price, new RegExp(`– ${dishes[0]}:`));
    // the menu of "quán thứ 3" directly
    const third = await d.follow("menu quán thứ 3");
    assert.equal(names(third)[0], a[2], third);
  } finally {
    d.stop();
  }
});
