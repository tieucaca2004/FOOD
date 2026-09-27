// GPT-2.1 Conversation Quality Patch (offline part): a NEW request is not answered from the previous list,
// real follow-ups still are; the prompt carries the voice and the no-repeat price rules. SCRIPTED provider
// (no network) captures exactly what the model would receive; SYNTHETIC knowledge fixture.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTestPlatform } from "../helpers/testPlatform.js";
import { nhaTrangKnowledge } from "../helpers/nhaTrangKnowledge.js";
import { createFoodKnowledge } from "../../services/foodKnowledgeAdapter.js";
import { FoodTools } from "../../ai/foodConcierge/foodTools.js";
import { GptFoodConcierge } from "../../ai/foodConcierge/GptFoodConcierge.js";
import { FOOD_CONCIERGE_INSTRUCTIONS } from "../../ai/foodConcierge/systemPrompt.js";

const final = (reply) => ({ output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ reply, items: [] }) }] }], functionCalls: [], text: JSON.stringify({ reply, items: [] }) });

function setup() {
  const seen = [];
  const provider = { model: "scripted-test-model", configured: true, async respond(req) { seen.push(JSON.parse(req.input[0].content.match(/^CONTEXT (.*)\n/)[1])); return final("Dạ em chưa có dữ liệu cho yêu cầu này ạ."); } };
  const file = nhaTrangKnowledge();
  const p = buildTestPlatform({
    withAtieu: true,
    atieuEngine: "generic",
    foodKnowledge: ({ services, merchantRouter }) => createFoodKnowledge({ dbPath: file, services, isRoutable: (m) => merchantRouter.isRoutable(m) }),
    gpt: ({ services, repos, agentSearch, merchantRouter }) => new GptFoodConcierge({ provider, tools: new FoodTools({ services, repos, agentSearch, merchantRouter }), timeoutMs: 5000, maxToolTurns: 6 }),
  });
  const customer = p.services.customers.getOrCreateByZaloUserId("q21", "T");
  const say = (text) => p.router.handle({ customer, session: p.services.sessions.getOrCreate(customer.id), text });
  const stored = () => p.services.sessions.getKnowledgeContext(p.services.sessions.getOrCreate(customer.id).id);
  return { say, seen, stored };
}

test("NEW REQUEST: 'tìm …' after a list is a new request — the old list is not restored and the model is told", async () => {
  const { say, seen, stored } = setup();
  await say("tìm bún cá"); // a list (knowledge, no orderable place) -> GPT turn 1
  assert.equal(seen[0].new_request, true);
  assert.equal(stored().query, "Bún cá");
  await say("tìm quán gần biển"); // new request, nothing found -> GPT turn 2
  assert.equal(seen[1].new_request, true);
  assert.equal(seen[1].previous_list, null); // not answered from the bún cá list
  assert.equal(stored(), null); // and the old list is not put back
});

test("REAL FOLLOW-UP: without a new request the list is kept — deterministically, or restored for the model", async () => {
  const { say, seen, stored } = setup();
  await say("tìm bún cá");
  const calls = seen.length;
  assert.match((await say("sao không có giá?")).replyText, /em mới xác minh được giá của 1 quán/); // deterministic, no model
  assert.match((await say("còn quán nào nữa?")).replyText, /Dạ em đã gửi hết|Thêm \d+ quán/);
  assert.equal(seen.length, calls);
  await say("cái nào có ghi rõ số tiền vậy"); // not a new request, not a known follow-up -> the model, with the list
  const last = seen.at(-1);
  assert.equal(last.new_request, false);
  assert.equal(last.previous_list?.query, "Bún cá");
  assert.equal(stored().query, "Bún cá");
});

test("PROMPT: voice (em / anh/chị / Dạ, never mình / bạn / tôi), price status not repeated, new_request rule", () => {
  const p = FOOD_CONCIERGE_INSTRUCTIONS;
  assert.match(p, /call yourself "em" and the customer "anh\/chị"/);
  assert.match(p, /start with "Dạ"/);
  assert.match(p, /Never use "mình", "bạn" or "tôi" as pronouns/);
  assert.match(p, /The system prints each product's price status itself/);
  assert.match(p, /Do not repeat it in "note"/);
  assert.doesNotMatch(p, /say that a verified price is not available/); // the old per-product instruction that caused the repeat
  assert.match(p, /When CONTEXT\.new_request is true/);
  assert.match(p, /do not answer from, filter or reuse the previous list/);
});
