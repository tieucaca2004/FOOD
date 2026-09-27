// GPT CONCIERGE ON SEARCH INTELLIGENCE V2 — channel E2E with a SCRIPTED model (no network, no key).
// Telegram / Zalo webhook -> PlatformRouter -> Search Intelligence V2 -> GPT concierge -> FOOD tools -> Fact Guard.
// The scripted model is "disciplined": it only reads CONTEXT.search_intelligence (V2), calls the suggested tool with
// the given args, and shows places by the ids the tool returned. It proves the V2 SearchResult is what reaches the
// model, that the tools answer from V2's reading, and that every final answer passed the Fact Guard.
// SYNTHETIC fixture (helpers/searchV2Knowledge.js). The REAL-model run is data/recovery/phase2/eval (needs a key).
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTestPlatform, startServer, baseUrl } from "../helpers/testPlatform.js";
import { searchV2Knowledge } from "../helpers/searchV2Knowledge.js";
import { createFoodKnowledge } from "../../services/foodKnowledgeAdapter.js";
import { FoodTools } from "../../ai/foodConcierge/foodTools.js";
import { GptFoodConcierge } from "../../ai/foodConcierge/GptFoodConcierge.js";
import { platformConfig } from "../../config.js";

platformConfig.telegramBotToken = "";
const SECRET = "test-telegram-secret-value";
let callSeq = 0;
const toolCall = (name, args) => {
  const id = `call_${++callSeq}`;
  const item = { type: "function_call", call_id: id, name, arguments: JSON.stringify(args) };
  return { output: [item], functionCalls: [{ callId: id, name, arguments: item.arguments }], text: "" };
};
const final = (answer) => ({ output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(answer) }] }], functionCalls: [], text: JSON.stringify(answer) });
const contextOf = (req) => JSON.parse(req.input[0].content.split("\n")[0].replace(/^CONTEXT /, ""));
const customerText = (req) => req.input[0].content.split("\nCUSTOMER: ")[1];

// the disciplined scripted model
class V2FollowingModel {
  constructor() {
    this.model = "scripted-v2-follower";
    this.configured = true;
    this.calls = [];
    this.turns = []; // one trace per customer message
  }
  async respond(req) {
    this.calls.push(req);
    const ctx = contextOf(req);
    const si = ctx.search_intelligence;
    const outputs = req.input.filter((i) => i.type === "function_call_output");
    let turn = this.turns.find((t) => t.req0 === req.input[0]);
    if (!turn) this.turns.push((turn = { req0: req.input[0], input: customerText(req), si, tools: [], answer: null }));
    if (!outputs.length) {
      if (si?.plan.type === "CLARIFY") {
        const options = (si.candidates.foods[0]?.options ?? []).slice(0, 3);
        turn.answer = { reply: options.length ? `Dạ anh/chị muốn tìm ${options.join(" hay ")} ạ?` : "Dạ anh/chị muốn hỏi món hoặc quán nào ạ?", items: [] };
        return final(turn.answer);
      }
      const tool = si?.suggested_tool ?? (ctx.previous_list ? { name: "get_previous_knowledge_results", args: {} } : null);
      if (tool) {
        turn.tools.push(tool);
        return toolCall(tool.name, tool.args);
      }
      turn.answer = { reply: "Dạ em chưa có dữ liệu phù hợp, anh/chị cho em biết món hoặc khu vực khác ạ.", items: [] };
      return final(turn.answer);
    }
    const data = JSON.parse(outputs.at(-1).output);
    turn.toolResult = data;
    const places = [...(data.catalog ?? []), ...(data.reference ?? []), ...(data.places ?? []), ...(data.merchant_id ? [data] : [])];
    const items = places.slice(0, 3).map((m) => ({ merchant_id: m.merchant_id, product_ids: (m.products ?? []).map((p) => p.product_id).slice(0, 3), note: "" }));
    turn.answer = { reply: items.length ? "Dạ em gửi anh/chị thông tin các quán ạ." : "Dạ em chưa có dữ liệu phù hợp ạ.", items };
    return final(turn.answer);
  }
}

async function withGpt(fn) {
  const saved = platformConfig.telegramWebhookSecret;
  platformConfig.telegramWebhookSecret = SECRET;
  const provider = new V2FollowingModel();
  const file = searchV2Knowledge();
  const p = buildTestPlatform({
    withAtieu: true,
    foodKnowledge: ({ services, merchantRouter }) => createFoodKnowledge({ dbPath: file, services, isRoutable: (m) => merchantRouter.isRoutable(m) }),
    gpt: ({ services, repos, agentSearch, merchantRouter }) => new GptFoodConcierge({ provider, tools: new FoodTools({ services, repos, agentSearch, merchantRouter }), timeoutMs: 5000, maxToolTurns: 4 }),
  });
  const server = await startServer(p.app);
  let seq = 0;
  let user = 97000;
  const conversation = (channel) => {
    const id = ++user;
    return async (text) => {
      seq += 1;
      const n = provider.calls.length;
      const req =
        channel === "telegram"
          ? { url: platformConfig.telegramWebhookPath, headers: { "x-telegram-bot-api-secret-token": SECRET }, body: { update_id: seq, message: { message_id: seq, from: { id, is_bot: false, first_name: "G" }, chat: { id, type: "private" }, date: 1, text } } }
          : { url: platformConfig.webhookPath, headers: {}, body: { event_name: "user_send_text", sender: { id: `zalo-gpt-${id}` }, message: { text, msg_id: `g-${seq}` }, timestamp: Date.now() } };
      const body = await fetch(`${baseUrl(server)}${req.url}`, { method: "POST", headers: { "content-type": "application/json", ...req.headers }, body: JSON.stringify(req.body) }).then((r) => r.json());
      assert.equal(body.status, "processed");
      const turn = provider.turns.find((t) => t.input === text && provider.calls.indexOf(provider.calls.find((c) => c.input[0] === t.req0)) >= n) ?? null;
      return { reply: body.reply_text, gptCalled: provider.calls.length > n, si: turn?.si ?? null, tools: turn?.tools ?? [], answer: turn?.answer ?? null };
    };
  };
  try {
    await fn({ conversation, provider });
  } finally {
    server.close();
    platformConfig.telegramWebhookSecret = saved;
  }
}

const CHANNELS = ["telegram", "zalo"];

test("V2 -> GPT: the model receives Search Intelligence V2 and calls the tool it suggests; the answer is built from tool facts", async () => {
  await withGpt(async ({ conversation }) => {
    for (const ch of CHANNELS) {
      const t = await conversation(ch)("bún cá");
      assert.equal(t.gptCalled, true, ch); // reference-only list: the concierge phrases it
      assert.equal(t.si.plan.type, "FOOD_DISCOVERY", ch);
      assert.deepEqual(t.si.entities.foods.map((f) => [f.name, f.match_type]), [["Bún cá", "EXACT_CANONICAL"]], ch);
      assert.deepEqual(t.tools, [{ name: "search_food", args: { query: "Bún cá" } }], ch);
      assert.match(t.reply, /Bún Cá Mịn|Bún cá Cô Ba|Nguyên Loan/, ch);
      const nd = await conversation(ch)("bun ca");
      assert.equal(nd.si.entities.foods[0].match_type, "APPROVED_NO_DIACRITIC", ch);
      assert.equal((await conversation(ch)("banh can")).si.entities.foods[0].name, "Bánh căn", ch);
    }
  });
});

test("V2 -> GPT CLARIFY: ambiguity / typo reach the model as candidates; it asks; nothing is searched; never Hủ Tiếu Xào Bò", async () => {
  await withGpt(async ({ conversation }) => {
    for (const ch of CHANNELS) {
      for (const [q, expect] of [["bun cca", /Bún cá/], ["hu tiu", /Hủ tiếu/], ["bún bò", /Bún bò Huế hay Bún bò Nam Bộ/]]) {
        const t = await conversation(ch)(q);
        assert.equal(t.si.plan.type, "CLARIFY", `${ch} ${q}`);
        assert.deepEqual(t.tools, [], `${ch} ${q}`);
        assert.match(t.reply, expect, `${ch} ${q}`); // the model's question passed the Fact Guard (V2-resolved names)
        assert.doesNotMatch(t.reply, /Hủ Tiếu Xào Bò/, `${ch} ${q}`);
      }
      const hue = await conversation(ch)("bún bò Huế");
      assert.equal(hue.si.plan.type, "FOOD_DISCOVERY", ch);
      assert.match(hue.reply, /Bún bò Huế Cố Đô/, ch);
      assert.doesNotMatch(hue.reply, /Hủ Tiếu Xào Bò/, ch);
    }
  });
});

test("V2 -> GPT CONTEXT: 'quán nào bán?' inherits the dish; list follow-ups stay deterministic on the same list", async () => {
  await withGpt(async ({ conversation }) => {
    for (const ch of CHANNELS) {
      const say = conversation(ch);
      const list = await say("Nha Trang có quán bún cá nào?");
      assert.equal(list.si.filters.region_id, "vn.khanh-hoa.nha-trang", ch);
      const which = await say("quán nào bán?");
      assert.equal(which.si.plan.type, "CONTEXT_DISCOVERY", ch);
      assert.deepEqual(which.si.context.used, ["currentFoodEntity"], ch);
      assert.deepEqual(which.tools[0], { name: "search_food", args: { query: "Bún cá" } }, ch);
      for (const q of ["quán đầu tiên ở đâu?", "quán đó có giá bao nhiêu?", "còn quán nào nữa?"]) {
        const t = await say(q);
        assert.equal(t.gptCalled, false, `${ch} ${q}`); // the remembered list answers
        assert.doesNotMatch(t.reply, /muốn hỏi .* của món hoặc quán nào/, `${ch} ${q}`);
      }
    }
  });
});

test("V2 -> GPT MERCHANT: a resolved place goes to the model as that place; its tool returns exactly it", async () => {
  await withGpt(async ({ conversation }) => {
    for (const ch of CHANNELS) {
      const ut = await conversation(ch)("Bánh căn Út Năm ở đâu?");
      assert.equal(ut.si.plan.type, "MERCHANT_OPERATION", ch);
      assert.equal(ut.si.candidates.merchants.length, 2, ch); // two recorded addresses
      assert.match(ut.reply, /16 Phạm Hồng Thái/, ch);
      assert.match(ut.reply, /127 Nguyễn Bỉnh Khiêm/, ch);
      const kiwami = await conversation(ch)("Kiwami ở đâu?");
      assert.equal(kiwami.tools[0].name, "get_merchant", ch);
      assert.match(kiwami.reply, /KIWAMI[\s\S]*136 Bạch Đằng/, ch);
      const vfruit = await conversation(ch)("Vfruit có món gì?");
      assert.equal(vfruit.tools[0].name, "get_menu", ch);
      assert.match(vfruit.reply, /Kem bơ/, ch);
      const pho = await conversation(ch)("Phở Hồng giá bao nhiêu?");
      assert.equal(pho.si.entities.merchant.names[0], "Phở Hồng", ch);
      assert.doesNotMatch(pho.reply, /Hồng Ngọc|\d{2}\.000đ/, ch); // no price recorded: none invented
    }
  });
});

test("V2 -> GPT PRICE: the budget is V2's structured filter; tools apply it; only recorded prices are shown", async () => {
  await withGpt(async ({ conversation }) => {
    for (const ch of CHANNELS) {
      for (const [q, min, max] of [["bún cá khoảng 50k", 40000, 60000], ["bún cá tầm 50k", 40000, 60000], ["bún cá dưới 50k", undefined, 50000], ["bún cá 30k đến 50k", 30000, 50000]]) {
        const t = await conversation(ch)(q);
        assert.equal(t.si.filters.price.max, max, `${ch} ${q}`);
        assert.deepEqual(t.tools[0], { name: "search_food", args: { query: "Bún cá", ...(min ? { min_price: min } : {}), max_price: max } }, `${ch} ${q}`);
        assert.match(t.reply, /Bún Cá Mịn/, `${ch} ${q}`); // 45.000đ recorded
        assert.doesNotMatch(t.reply, /Rejected Test|10\.000đ/, `${ch} ${q}`);
      }
    }
  });
});

test("V2 -> GPT MERCHANT CONTEXT vs GLOBAL; ORDERING never reaches the model", async () => {
  await withGpt(async ({ conversation }) => {
    for (const ch of CHANNELS) {
      const say = conversation(ch);
      assert.match((await say("Menu A Tiểu")).reply, /Hủ Tiếu Xào Bò/, ch);
      const full = await say("full menu");
      assert.equal(full.gptCalled, false, ch);
      assert.match(full.reply, /Hủ Tiếu Xào Bò/, ch);
      const add = await say("2 tô hủ tiếu xào bò");
      assert.equal(add.gptCalled, false, ch); // A Tiểu's own engine
      const two = await say("cho 2 tô");
      assert.equal(two.gptCalled, false, ch);
      const other = await say("ngoài quán này còn bún cá nào?");
      assert.equal(other.si.plan.type, "FOOD_DISCOVERY", ch);
      assert.deepEqual(other.si.entities.exclusions, [{ type: "merchant", id: "cat:ATIEU001" }], ch);
      assert.match(other.reply, /Bún Cá Mịn|Bún cá Cô Ba|Nguyên Loan/, ch);
      assert.doesNotMatch(other.reply, /HỦ TIẾU XÀO A TIỂU/, ch);
      const area = await conversation(ch)("xung quanh Nha Trang có món gì?");
      assert.equal(area.gptCalled, false, ch); // the dish summary is FOOD's own data
      assert.match(area.reply, /FOOD có dữ liệu tham khảo về các món[\s\S]*chưa có tọa độ|chưa có tọa độ[\s\S]*FOOD có dữ liệu tham khảo về các món/, ch);
    }
  });
});

test("V2 -> GPT ISOLATION: the context the model gets is this customer's; the SearchResult carries no prices or menus", async () => {
  await withGpt(async ({ conversation, provider }) => {
    await conversation("telegram")("Nha Trang có quán bún cá nào?");
    const b = await conversation("zalo")("quán nào bán?");
    assert.equal(b.si?.plan.type ?? "CLARIFY", "CLARIFY"); // B has no dish in its conversation
    for (const req of provider.calls) {
      const si = contextOf(req).search_intelligence;
      assert.ok(si, "every model call carries search_intelligence");
      assert.doesNotMatch(JSON.stringify(si), /\d{2}\.000đ|giá tham khảo/); // FOOD's reading, never facts
    }
  });
});
