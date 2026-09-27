// PHASE B — Search Intelligence V2 is the ONE query reader of a turn; the GPT concierge and its tools use that reading.
// Telegram / Zalo webhook -> PlatformRouter -> V2 (once) -> GPT concierge (scripted model, no network) -> FOOD tools
// -> Fact Guard. Also the Founder-approved canonical name "bún bò" -> "Bún bò Huế" (approved term relations) across
// V2, the deterministic path, the tools, the model's context and follow-ups. SYNTHETIC fixture only.
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
const CHANNELS = ["telegram", "zalo"];
const HU_TIEU_XAO_BO = /Hủ Tiếu Xào Bò|HỦ TIẾU XÀO BÒ/;
let callSeq = 0;
const toolCall = (name, args) => {
  const id = `call_${++callSeq}`;
  const item = { type: "function_call", call_id: id, name, arguments: JSON.stringify(args) };
  return { output: [item], functionCalls: [{ callId: id, name, arguments: item.arguments }], text: "" };
};
const final = (answer) => ({ output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(answer) }] }], functionCalls: [], text: JSON.stringify(answer) });
const contextOf = (req) => JSON.parse(req.input[0].content.split("\n")[0].replace(/^CONTEXT /, ""));

// a disciplined scripted model: reads CONTEXT.search_intelligence only, calls its suggested tool, shows what came back
class Model {
  constructor() {
    this.model = "scripted";
    this.configured = true;
    this.calls = [];
  }
  async respond(req) {
    this.calls.push(req);
    const si = contextOf(req).search_intelligence;
    const outputs = req.input.filter((i) => i.type === "function_call_output");
    if (!outputs.length) {
      if (si?.plan.type === "CLARIFY") return final({ reply: `Dạ anh/chị muốn tìm ${(si.candidates.foods[0]?.options ?? ["món nào"]).join(" hay ")} ạ?`, items: [] });
      if (si?.suggested_tool) return toolCall(si.suggested_tool.name, si.suggested_tool.args);
      return final({ reply: "Dạ anh/chị cho em biết món hoặc quán muốn tìm ạ.", items: [] });
    }
    const data = JSON.parse(outputs.at(-1).output);
    const places = [...(data.catalog ?? []), ...(data.reference ?? []), ...(data.places ?? []), ...(data.merchant_id ? [data] : [])];
    return final({ reply: places.length ? "Dạ em gửi anh/chị thông tin các quán ạ." : "Dạ em chưa có dữ liệu phù hợp ạ.", items: places.slice(0, 3).map((m) => ({ merchant_id: m.merchant_id, product_ids: (m.products ?? []).map((p) => p.product_id).slice(0, 2), note: "" })) });
  }
}

// counts every Search Intelligence V2 reading (text -> times read) and records every tool result
async function withChat(fn, { gpt = true, bunBoHue = false } = {}) {
  const saved = platformConfig.telegramWebhookSecret;
  platformConfig.telegramWebhookSecret = SECRET;
  const provider = new Model();
  const reads = [];
  const toolResults = [];
  const file = searchV2Knowledge({ bunBoHue });
  const p = buildTestPlatform({
    withAtieu: true,
    foodKnowledge: ({ services, merchantRouter }) => {
      const fk = createFoodKnowledge({ dbPath: file, services, isRoutable: (m) => merchantRouter.isRoutable(m) });
      const build = fk.searchIntelligence.bind(fk);
      fk.searchIntelligence = () => {
        const si = build();
        if (!si.__counted) {
          const understand = si.understand.bind(si);
          si.understand = (text, opts) => {
            reads.push(text);
            return understand(text, opts);
          };
          si.__counted = true;
        }
        return si;
      };
      return fk;
    },
    gpt: gpt
      ? ({ services, repos, agentSearch, merchantRouter }) => {
          const tools = new FoodTools({ services, repos, agentSearch, merchantRouter });
          const run = tools.run.bind(tools);
          tools.run = async (name, args, ctx) => {
            const r = await run(name, args, ctx);
            toolResults.push({ name, args, data: r.data });
            return r;
          };
          return new GptFoodConcierge({ provider, tools, timeoutMs: 5000, maxToolTurns: 4 });
        }
      : null,
  });
  const server = await startServer(p.app);
  let seq = 0;
  let user = 88000;
  const conversation = (channel) => {
    const id = ++user;
    return async (text) => {
      seq += 1;
      const n = provider.calls.length;
      const t = toolResults.length;
      reads.length = 0;
      const req =
        channel === "telegram"
          ? { url: platformConfig.telegramWebhookPath, headers: { "x-telegram-bot-api-secret-token": SECRET }, body: { update_id: seq, message: { message_id: seq, from: { id, is_bot: false, first_name: "B" }, chat: { id, type: "private" }, date: 1, text } } }
          : { url: platformConfig.webhookPath, headers: {}, body: { event_name: "user_send_text", sender: { id: `zalo-b-${id}` }, message: { text, msg_id: `b-${seq}` }, timestamp: Date.now() } };
      const body = await fetch(`${baseUrl(server)}${req.url}`, { method: "POST", headers: { "content-type": "application/json", ...req.headers }, body: JSON.stringify(req.body) }).then((r) => r.json());
      assert.equal(body.status, "processed");
      const calls = provider.calls.slice(n);
      return { reply: body.reply_text, gptCalled: calls.length > 0, si: calls.length ? contextOf(calls[0]).search_intelligence : null, readsOfText: reads.filter((x) => x === text).length, tools: toolResults.slice(t) };
    };
  };
  try {
    await fn({ conversation });
  } finally {
    server.close();
    platformConfig.telegramWebhookSecret = saved;
  }
}

test("V2 CANONICAL: one reading of the message per turn; every concierge call gets it (plan path AND _discover path)", async () => {
  await withChat(async ({ conversation }) => {
    for (const ch of CHANNELS) {
      // planned by V2 (FOOD_DISCOVERY, reference only) -> concierge
      const planned = await conversation(ch)("bún cá khoảng 50k");
      assert.equal(planned.gptCalled, true, ch);
      assert.equal(planned.si.plan.type, "FOOD_DISCOVERY", ch);
      assert.equal(planned.readsOfText, 1, `${ch}: the customer's words are read once`);
      // V2 resolves nothing -> the legacy search runs -> concierge: it still gets THAT reading, never a second one
      for (const q of ["tìm món ăn sáng", "có đồ chay không"]) {
        const t = await conversation(ch)(q);
        assert.equal(t.gptCalled, true, `${ch} ${q}`);
        assert.equal(t.si.plan.type, "DEFER", `${ch} ${q}`);
        assert.equal(t.si.plan.reason, "NOTHING_RESOLVED", `${ch} ${q}`);
        assert.equal(t.readsOfText, 1, `${ch} ${q}: read once (router), not again by the concierge`);
      }
    }
  });
});

test("V2 CANONICAL: the tools honour the turn's reading — a place the customer excluded is never listed by a tool", async () => {
  await withChat(async ({ conversation }) => {
    for (const ch of CHANNELS) {
      const say = conversation(ch);
      await say("Menu A Tiểu");
      const t = await say("ngoài quán này còn hủ tiếu nào?");
      assert.deepEqual(t.si.entities.exclusions, [{ type: "merchant", id: "cat:ATIEU001" }], ch);
      const search = t.tools.find((x) => x.name === "search_food");
      assert.ok(search, `${ch}: the model searched`);
      assert.deepEqual(search.data.catalog.map((c) => c.merchant_id).filter((id) => id === "cat:ATIEU001"), [], `${ch}: excluded place not returned`);
      assert.doesNotMatch(t.reply, /HỦ TIẾU XÀO A TIỂU|Hủ Tiếu Xào A Tiểu/, ch);
      assert.match(t.reply, /Hủ tiếu Cô Năm|Bayon/, ch);
    }
  });
});

test("BÚN BÒ HUẾ (Founder-approved names): bún bò / bun bo / bún bò huế / bun bo hue are one canonical dish; negatives stay apart", async () => {
  for (const gpt of [false, true]) {
    await withChat(
      async ({ conversation }) => {
        for (const ch of CHANNELS) {
          const tag = `${ch} gpt=${gpt}`;
          for (const q of ["bún bò", "bun bo", "bún bò Huế", "bun bo hue", "quán nào bán bún bò?", "bún bò ở đâu?"]) {
            const t = await conversation(ch)(q);
            assert.match(t.reply, /Bún bò Huế Cố Đô/, `${tag} ${q}`);
            assert.doesNotMatch(t.reply, HU_TIEU_XAO_BO, `${tag} ${q}`);
            assert.doesNotMatch(t.reply, /Bún bò Nam Bộ|Bún bò 100 Ngô Gia Tự/, `${tag} ${q}`); // Nam Bộ / the unpublished "Bún bò" entity
            if (gpt && t.gptCalled) {
              assert.deepEqual(t.si.entities.foods.map((f) => f.name), ["Bún bò Huế"], `${tag} ${q}`);
              assert.equal(t.si.plan.type, "FOOD_DISCOVERY", `${tag} ${q}`);
              assert.equal(t.tools[0].args.query, "Bún bò Huế", `${tag} ${q}`);
            }
          }
          const nam = await conversation(ch)("bún bò Nam Bộ");
          assert.doesNotMatch(nam.reply, /Bún bò Huế Cố Đô/, `${tag} nam bộ`);
          if (gpt && nam.gptCalled) assert.deepEqual(nam.si.entities.foods.map((f) => f.name), ["Bún bò Nam Bộ"], tag);
          const hu = await conversation(ch)("hủ tiếu xào bò");
          assert.doesNotMatch(hu.reply, /Bún bò Huế/, `${tag} hủ tiếu xào bò`);
          if (gpt && hu.gptCalled) assert.deepEqual(hu.si.entities.foods.map((f) => f.name), ["Hủ tiếu"], tag);
          const bo = await conversation(ch)("bò");
          assert.doesNotMatch(bo.reply, /Bún bò Huế/, `${tag} bò`);
          // follow-ups keep the canonical dish
          const say = conversation(ch);
          await say("bún bò");
          const which = await say("quán nào bán?");
          assert.match(which.reply, /Bún bò Huế Cố Đô/, `${tag} quán nào bán?`);
          if (gpt && which.gptCalled) assert.deepEqual(which.si.entities.foods.map((f) => f.name), ["Bún bò Huế"], tag);
          const first = await say("quán đầu tiên ở đâu?");
          assert.match(first.reply, /17 Hoàng Diệu/, `${tag} quán đầu tiên`);
          const price = await say("quán đó có giá bao nhiêu?");
          assert.match(price.reply, /40\.000đ/, `${tag} giá`); // the recorded reference price, nothing else
          assert.doesNotMatch(price.reply, HU_TIEU_XAO_BO, tag);
        }
      },
      { gpt, bunBoHue: true }
    );
  }
});

test("BÚN BÒ inside A Tiểu: never Hủ Tiếu Xào Bò; FOOD points to the Bún bò Huế places elsewhere", async () => {
  await withChat(
    async ({ conversation }) => {
      for (const ch of CHANNELS) {
        const say = conversation(ch);
        await say("Menu A Tiểu");
        const r = await say("Có bún bò ko");
        assert.doesNotMatch(r.reply, /Dạ có ạ|Đã thêm/, ch);
        assert.doesNotMatch(r.reply, HU_TIEU_XAO_BO, ch);
        assert.match(r.reply, /Bún bò Huế/, ch);
      }
    },
    { gpt: false, bunBoHue: true }
  );
});
