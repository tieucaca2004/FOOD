// CHANNEL E2E (offline): Telegram webhook / Zalo webhook -> PlatformRouter -> Search Intelligence -> GPT concierge
// (SCRIPTED model, no network) -> FOOD tools -> reply. Same concierge for both channels; per-customer context.
// SYNTHETIC Nha Trang fixture. The REAL-model version of this flow is test/live/searchLive.test.js (needs a key).
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTestPlatform, startServer, baseUrl } from "../helpers/testPlatform.js";
import { nhaTrangKnowledge } from "../helpers/nhaTrangKnowledge.js";
import { createFoodKnowledge } from "../../services/foodKnowledgeAdapter.js";
import { FoodTools } from "../../ai/foodConcierge/foodTools.js";
import { GptFoodConcierge } from "../../ai/foodConcierge/GptFoodConcierge.js";
import { KnowledgeAwareConcierge, createKnowledgeLayers } from "../../ai/foodConcierge/knowledgeLayers.js";
import { platformConfig } from "../../config.js";

platformConfig.telegramBotToken = "";
const SECRET = "test-telegram-secret-value";
const contextOf = (req) => JSON.parse(req.input[0].content.split("\n")[0].replace(/^CONTEXT /, ""));
const customerText = (req) => req.input[0].content.split("\nCUSTOMER: ")[1];

// a scripted model that always answers briefly (or fails when asked to), recording what it was given
const model = ({ fail = false } = {}) => ({
  model: "scripted",
  configured: true,
  calls: [],
  async respond(req) {
    this.calls.push(req);
    if (fail) throw Object.assign(new Error("OpenAI HTTP 500 internal"), { kind: "http", status: 500 });
    return { output: [], functionCalls: [], text: JSON.stringify({ reply: "Dạ em hỏi lại chút ạ: anh/chị muốn món gì?", items: [] }) };
  },
});

async function withChannels({ search = true, fail = false } = {}, fn) {
  const saved = platformConfig.telegramWebhookSecret;
  platformConfig.telegramWebhookSecret = SECRET;
  const file = nhaTrangKnowledge();
  const provider = model({ fail });
  let built = 0;
  const p = buildTestPlatform({
    withAtieu: true,
    atieuEngine: "generic",
    withNomNomDemo: true,
    foodKnowledge: ({ services, merchantRouter }) => createFoodKnowledge({ dbPath: file, services, isRoutable: (m) => merchantRouter.isRoutable(m) }),
    gpt: ({ services, repos, agentSearch, merchantRouter }) => {
      built += 1;
      const tools = new FoodTools({ services, repos, agentSearch, merchantRouter });
      return search ? new KnowledgeAwareConcierge({ provider, tools, timeoutMs: 5000, maxToolTurns: 6, layers: createKnowledgeLayers({ tools, search: true, alias: true }) }) : new GptFoodConcierge({ provider, tools, timeoutMs: 5000, maxToolTurns: 6 });
    },
  });
  const server = await startServer(p.app);
  let seq = 0;
  const telegram = async (text, user) => {
    seq += 1;
    const body = await fetch(`${baseUrl(server)}${platformConfig.telegramWebhookPath}`, { method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": SECRET }, body: JSON.stringify({ update_id: seq, message: { message_id: seq, from: { id: user, is_bot: false, first_name: "T" }, chat: { id: user, type: "private" }, date: 1, text } }) }).then((r) => r.json());
    assert.equal(body.status, "processed");
    return body.reply_text;
  };
  const zalo = async (text, user) => {
    seq += 1;
    const body = await fetch(`${baseUrl(server)}/platform/webhook`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ event_name: "user_send_text", sender: { id: String(user) }, message: { text, msg_id: `z${seq}` }, timestamp: Date.now() }) }).then((r) => r.json());
    assert.equal(body.status, "processed");
    return body.reply_text;
  };
  try {
    await fn({ telegram, zalo, provider, p, built: () => built });
  } finally {
    server.close();
    platformConfig.telegramWebhookSecret = saved;
  }
}

test("E2E: a budget the catalog search cannot answer reaches the model with Search Intelligence V2 — Telegram AND Zalo, one concierge", async () => {
  await withChannels({}, async ({ telegram, zalo, provider, built }) => {
    for (const [send, user] of [[telegram, 8101], [zalo, 8102]]) {
      const n = provider.calls.length;
      const reply = await send("pizza dưới 50k", user); // no catalog hit with a budget -> the model answers
      assert.ok(provider.calls.length > n, "the model was asked");
      const si = contextOf(provider.calls.at(-1)).search_intelligence; // V2: the one reading of the message
      assert.equal(si.filters.price.max, 50000);
      assert.match(reply, /anh\/chị muốn món gì/);
    }
    assert.equal(built(), 1);
  });
});

test("E2E FLAG OFF: the GPT-2 concierge gets no search_intent; a catalog hit stays deterministic either way", async () => {
  await withChannels({ search: false }, async ({ telegram, provider }) => {
    await telegram("pizza dưới 50k", 8201);
    assert.equal("search_intent" in contextOf(provider.calls.at(-1)), false);
    const n = provider.calls.length;
    assert.match(await telegram("tìm pizza", 8202), /NÔM NÔM|Nôm Nôm/i); // an orderable catalog list: no model call
    assert.equal(provider.calls.length, n);
  });
  await withChannels({ search: true }, async ({ telegram, provider }) => {
    assert.match(await telegram("tìm pizza", 8203), /NÔM NÔM|Nôm Nôm/i);
    assert.equal(provider.calls.length, 0); // router unchanged: the flag never overrides an orderable list
  });
});

test("E2E SESSION ISOLATION + FOLLOW-UP + PAGINATION: A's list never reaches B (Telegram A, Zalo B)", async () => {
  await withChannels({}, async ({ telegram, zalo, provider }) => {
    await telegram("tìm bún cá ở Nha Trang", 8301); // reference list for A (no catalog place -> model answers)
    const more = await telegram("còn quán nào nữa", 8301); // deterministic follow-up on A's list
    assert.doesNotMatch(more, /hỏi quán nào|muốn hỏi thông tin/);
    await zalo("còn quán nào nữa", 8302); // B has no list
    const bCalls = provider.calls.filter((r) => customerText(r) === "còn quán nào nữa");
    for (const r of bCalls) assert.equal(contextOf(r).previous_list, null); // B's model context never holds A's list
    const aCall = provider.calls.find((r) => customerText(r) === "tìm bún cá ở Nha Trang");
    assert.equal(contextOf(aCall).search_intelligence.entities.foods[0].name, "Bún cá");
  });
});

test("E2E ERROR FALLBACK: a failing model gives the deterministic answer — never an error text", async () => {
  await withChannels({ fail: true }, async ({ telegram, zalo }) => {
    for (const reply of [await telegram("pizza dưới 50k", 8401), await zalo("tìm bún cá ở Nha Trang", 8402)]) {
      assert.ok(reply && reply.length > 0);
      assert.doesNotMatch(reply, /OpenAI|HTTP 500|internal|stack|Error/);
    }
  });
});
