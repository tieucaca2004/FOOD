// GPT FOOD concierge end to end over the (simulated) Telegram webhook, with a SCRIPTED provider
// standing in for the model — the real OpenAI API is never called in tests. The knowledge rows are
// SYNTHETIC FIXTURES. What is under test is everything around the model: tool execution, the
// backend-rendered facts, the Fact Guard, fallbacks, routing and the cart / order boundary.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTestPlatform, startServer, baseUrl } from "../helpers/testPlatform.js";
import { nhaTrangKnowledge } from "../helpers/nhaTrangKnowledge.js";
import { createFoodKnowledge } from "../../services/foodKnowledgeAdapter.js";
import { FoodTools } from "../../ai/foodConcierge/foodTools.js";
import { GptFoodConcierge } from "../../ai/foodConcierge/GptFoodConcierge.js";
import { OpenAIProviderError } from "../../ai/openai/OpenAIProvider.js";
import { createGptFoodConcierge } from "../../ai/index.js";
import { platformConfig } from "../../config.js";

platformConfig.telegramBotToken = "";
const TEST_SECRET = "test-telegram-secret-value";

// ---- scripted model -------------------------------------------------------------------------
class ScriptedProvider {
  constructor(script) {
    this.script = script; // (req, turn) => response, or an array of those
    this.model = "scripted-test-model";
    this.configured = true;
    this.calls = [];
  }
  async respond(req) {
    this.calls.push(req);
    const step = Array.isArray(this.script) ? this.script.shift() : this.script;
    if (!step) throw new Error("script exhausted");
    return typeof step === "function" ? step(req, this.calls.length) : step;
  }
}
let callSeq = 0;
const toolCall = (name, args) => {
  const id = `call_${++callSeq}`;
  const item = { type: "function_call", call_id: id, name, arguments: typeof args === "string" ? args : JSON.stringify(args) };
  return { output: [item], functionCalls: [{ callId: id, name, arguments: item.arguments }], text: "" };
};
const final = (answer) => {
  const text = JSON.stringify(answer);
  return { output: [{ type: "message", content: [{ type: "output_text", text }] }], functionCalls: [], text };
};
const lastToolOutput = (req) => {
  const outs = req.input.filter((i) => i.type === "function_call_output");
  return JSON.parse(outs.at(-1).output);
};
const pick = (req, name) => {
  const data = lastToolOutput(req);
  const places = data.reference ?? data.places ?? [];
  const m = places.find((x) => x.merchant_name === name);
  return { merchant_id: m.merchant_id, product_ids: m.products.map((p) => p.product_id), note: "" };
};

// ---- platform over the webhook ------------------------------------------------------------------
async function withGpt(script, fn, { gptEnabled = true } = {}) {
  const originalSecret = platformConfig.telegramWebhookSecret;
  platformConfig.telegramWebhookSecret = TEST_SECRET;
  const file = nhaTrangKnowledge();
  const provider = new ScriptedProvider(script);
  const logs = [];
  const logger = { info: (category, message, meta) => logs.push({ category, message, meta }) };
  const platform = buildTestPlatform({
    withAtieu: true,
    atieuEngine: "generic",
    withNomNomDemo: true,
    foodKnowledge: ({ services, merchantRouter }) => createFoodKnowledge({ dbPath: file, services, isRoutable: (m) => merchantRouter.isRoutable(m) }),
    gpt: gptEnabled ? ({ services, repos, agentSearch, merchantRouter }) => new GptFoodConcierge({ provider, tools: new FoodTools({ services, repos, agentSearch, merchantRouter }), logger, timeoutMs: 5000, maxToolTurns: 3 }) : null,
  });
  const server = await startServer(platform.app);
  let seq = 0;
  const telegram = async (text, userId = 777) => {
    seq += 1;
    const res = await fetch(`${baseUrl(server)}${platformConfig.telegramWebhookPath}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": TEST_SECRET },
      body: JSON.stringify({ update_id: seq, message: { message_id: seq, from: { id: userId, is_bot: false, first_name: "K" }, chat: { id: userId, type: "private" }, date: 1, text } }),
    });
    const body = await res.json();
    assert.equal(body.status, "processed");
    return body.reply_text;
  };
  const counts = () => ["merchants", "merchant_products", "merchant_carts", "merchant_cart_items", "orders", "payments"].map((t) => platform.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n);
  try {
    await fn({ platform, telegram, provider, logs, counts });
  } finally {
    server.close();
    platformConfig.telegramWebhookSecret = originalSecret;
  }
}

const bunCaNhaTrang = () => [
  toolCall("search_food", { query: "bún cá", location: "Nha Trang" }),
  (req) => final({ reply: "Dạ em tìm được các quán bún cá sau ạ.", items: [pick(req, "Bún Cá Mẫu"), pick(req, "Bún cá Cô Ba")] }),
];

test("GPT DISCOVERY: tools + backend-rendered facts; reference only; no cart / order / payment", async () => {
  await withGpt(bunCaNhaTrang(), async ({ telegram, provider, logs, counts }) => {
    const before = counts();
    const reply = await telegram("tìm quán bún cá ở Nha Trang");
    assert.match(reply, /^Dạ em tìm được các quán bún cá sau ạ\./);
    assert.match(reply, /📍 Bún Cá Mẫu\n📌 170 Bạch Đằng, Tân Lập, Nha Trang\n🍜 Bún cá\n💰 45\.000đ\n🔗 buncamau\.example · 🕒 ghi nhận \d\d\/\d\d\/\d{4}/);
    assert.match(reply, /📍 Bún cá Cô Ba[\s\S]*⚠️ Chưa có giá xác thực từ nguồn hiện có\./); // price null -> no price
    assert.doesNotMatch(reply, /✅ Đặt được qua FOOD/); // reference only
    assert.equal((reply.match(/ℹ️ Thông tin tham khảo — chưa đặt qua FOOD được\./g) ?? []).length, 2);
    assert.equal(provider.calls.length, 2);
    assert.ok(provider.calls[0].tools.some((t) => t.name === "search_food"));
    assert.equal(provider.calls[0].format.name, "food_concierge_answer");
    assert.deepEqual(counts(), before);
    // observability without the prompt, the customer's words or a key
    const log = logs.find((l) => l.message === "gpt concierge turn").meta;
    assert.equal(log.mode, "gpt");
    assert.equal(log.model, "scripted-test-model");
    assert.equal(log.reason, "discovery");
    assert.deepEqual(log.tools.map((t) => t.toolName), ["search_food"]);
    assert.ok(!JSON.stringify(logs).includes("tìm quán bún cá"));
  });
});

test("HALLUCINATION: an invented price / orderability / merchant / name never reaches the customer", async () => {
  const deterministic = /Em tìm thấy \d+ quán có dữ liệu phù hợp/;
  const cases = [
    ["price", (req) => final({ reply: "Bún cá ở đây giá 50.000đ ạ.", items: [pick(req, "Bún cá Cô Ba")] })],
    ["typical price", (req) => final({ reply: "Thường khoảng 40k một tô.", items: [pick(req, "Bún cá Cô Ba")] })],
    ["orderable", (req) => final({ reply: "Anh đặt được qua FOOD luôn nha.", items: [pick(req, "Bún Cá Mẫu")] })],
    ["invented merchant id", () => final({ reply: "Dạ.", items: [{ merchant_id: "kb:424242", product_ids: [], note: "" }] })],
    ["invented name", (req) => final({ reply: "Anh thử thêm Quán Hoàng Gia Mới nhé.", items: [pick(req, "Bún Cá Mẫu")] })],
    ["open now", (req) => final({ reply: "Quán đang mở đó anh.", items: [pick(req, "Bún Cá Mẫu")] })],
  ];
  for (const [label, bad] of cases) {
    // the model repeats the same mistake after the Fact Guard's feedback -> deterministic fallback
    await withGpt([toolCall("search_food", { query: "bún cá", location: "Nha Trang" }), bad, bad], async ({ telegram, logs }) => {
      const reply = await telegram("tìm quán bún cá ở Nha Trang");
      assert.match(reply, deterministic, label);
      assert.doesNotMatch(reply, /50\.000đ|40k|Hoàng Gia|đang mở|424242/, label);
      const log = logs.find((l) => l.message === "gpt concierge turn").meta;
      assert.equal(log.mode, "deterministic_fallback", label);
      assert.equal(log.fallbackReason, "fact_guard", label);
    });
  }
});

test("FACT GUARD RETRY: a corrected second answer is used; the feedback names the violation", async () => {
  const script = [
    toolCall("search_food", { query: "bún cá", location: "Nha Trang" }),
    (req) => final({ reply: "Quán này giá 50.000đ.", items: [pick(req, "Bún Cá Mẫu")] }),
    (req) => {
      assert.match(req.input.at(-1).content, /FACT_GUARD_REJECTED: UNSUPPORTED_PRICE 50\.000đ/);
      const data = JSON.parse(req.input.filter((i) => i.type === "function_call_output").at(-1).output);
      const m = data.reference.find((x) => x.merchant_name === "Bún Cá Mẫu");
      return final({ reply: "Dạ quán này có giá ghi trong nguồn ạ.", items: [{ merchant_id: m.merchant_id, product_ids: m.products.map((p) => p.product_id), note: "" }] });
    },
  ];
  await withGpt(script, async ({ telegram, logs }) => {
    const reply = await telegram("tìm quán bún cá ở Nha Trang");
    assert.match(reply, /💰 45\.000đ/);
    assert.doesNotMatch(reply, /50\.000đ/);
    assert.equal(logs.at(-1).meta.guardRetries, 1);
  });
});

test("FAILURES fall back to the deterministic answer: timeout, rate limit, bad JSON, runaway tool loop, bad tool args", async () => {
  const deterministic = /Em tìm thấy \d+ quán có dữ liệu phù hợp/;
  const cases = [
    ["timeout", [() => { throw new OpenAIProviderError("timeout", "t"); }]],
    ["rate_limit", [() => { throw new OpenAIProviderError("rate_limit", "r", 429); }]],
    ["invalid_json", [{ output: [], functionCalls: [], text: "not json" }]],
    ["max_tool_turns", () => toolCall("search_food", { query: "bún cá" })],
  ];
  for (const [reason, script] of cases) {
    await withGpt(script, async ({ telegram, logs }) => {
      assert.match(await telegram("tìm quán bún cá ở Nha Trang"), deterministic, reason);
      assert.equal(logs.at(-1).meta.fallbackReason, reason);
    });
  }
  // malformed tool arguments are rejected safely and the conversation continues
  await withGpt([toolCall("search_food", "{not json"), (req) => {
    assert.equal(lastToolOutput(req).error, "INVALID_ARGUMENTS"); // rejected by the registry before any handler
    return final({ reply: "Anh muốn tìm món gì ạ?", items: [] });
  }], async ({ telegram, logs }) => {
    assert.equal(await telegram("tìm quán bún cá ở Nha Trang"), "Anh muốn tìm món gì ạ?");
    assert.equal(logs.at(-1).meta.tools[0].errorType, "INVALID_ARGUMENTS");
  });
});

test("DETERMINISTIC FIRST: orderable catalog results and follow-ups never call the model", async () => {
  await withGpt(bunCaNhaTrang(), async ({ telegram, provider }) => {
    assert.match(await telegram("tìm hủ tiếu"), /HỦ TIẾU XÀO A TIỂU/); // catalog found -> deterministic
    assert.equal(provider.calls.length, 0);
    await telegram("tìm quán bún cá ở Nha Trang"); // no catalog -> GPT
    const calls = provider.calls.length;
    for (const q of ["sao không có giá?", "còn quán nào nữa?", "quán nào có giá?", "địa chỉ quán đầu"]) {
      const reply = await telegram(q);
      assert.doesNotMatch(reply, /chưa tìm thấy quán|Lát cá tẩm bột|Lòng lợn/, q); // "còn" is never a dish
    }
    assert.equal(provider.calls.length, calls); // follow-ups: deterministic, about the remembered list
    assert.match(await telegram("sao không có giá?"), /em mới xác minh được giá của 1 quán/);
  });
});

test("FOLLOW-UP via GPT: the model reads the previous list instead of searching the question", async () => {
  const script = [
    ...bunCaNhaTrang(),
    toolCall("get_previous_knowledge_results", {}),
    (req) => {
      const data = lastToolOutput(req);
      assert.equal(data.available, true);
      assert.equal(data.query, "Bún cá");
      const m = data.places.find((p) => p.merchant_name === "Bún Cá Mẫu");
      return final({ reply: "Trong danh sách vừa rồi, quán này có giá ghi trong nguồn ạ.", items: [{ merchant_id: m.merchant_id, product_ids: m.products.map((p) => p.product_id), note: "" }] });
    },
  ];
  await withGpt(script, async ({ telegram, provider, platform }) => {
    await telegram("tìm quán bún cá ở Nha Trang", 901);
    // a follow-up phrasing the deterministic classifier does not know -> unknown -> GPT with the remembered list
    const reply = await telegram("cái nào có ghi rõ số tiền vậy", 901);
    assert.match(reply, /📍 Bún Cá Mẫu[\s\S]*💰 45\.000đ/);
    assert.equal(provider.calls.at(-2).input.filter((i) => i.type === "function_call_output").length, 1);
    const knowledgeQuery = (p, u) =>
      JSON.parse(p.db.prepare(`SELECT s.knowledge_context_json j FROM platform_sessions s JOIN platform_customers c ON c.id = s.customer_id WHERE c.zalo_user_id LIKE ? ORDER BY s.id DESC`).get(`%${u}`).j).query;
    assert.equal(knowledgeQuery(platform, 901), "Bún cá"); // the list the conversation is about survived
  });
});

test("MERCHANT CONTEXT: inside Nôm Nôm with a cart, discovery goes global (cart kept); ordering stays deterministic", async () => {
  const script = [
    toolCall("search_food", { query: "Bún Cá Mịn" }),
    (req) => final({ reply: "Dạ đây là thông tin quán ạ.", items: [pick(req, "Bún Cá Mịn")] }),
    toolCall("search_food", { query: "bánh căn", location: "Nha Trang" }),
    (req) => final({ reply: "Dạ có quán bánh căn này ạ.", items: [pick(req, "Bánh căn Cô Tư")] }),
  ];
  await withGpt(script, async ({ telegram, provider, platform, counts }) => {
    const u = 950;
    await telegram("Xem quán Nôm Nôm", u);
    assert.match(await telegram("cho tôi 1 Seafood Pizza", u), /Đã thêm/);
    const cartItems = () => platform.db.prepare(`SELECT COALESCE(SUM(quantity), 0) AS q FROM merchant_cart_items`).get().q;
    const before = { cart: cartItems(), counts: counts() };
    const min = await telegram("tìm Bún Cá Mịn", u);
    assert.match(min, /📍 Bún Cá Mịn\n📌 12 Lý Tự Trọng, Nha Trang[\s\S]*💰 45\.000đ/);
    assert.equal(cartItems(), before.cart);
    // ordering is the merchant's, deterministic, never the model
    const calls = provider.calls.length;
    assert.match(await telegram("Xem quán Nôm Nôm", u), /Đã mở/);
    assert.match(await telegram("cho tôi 2 pizza", u), /Đã thêm 2 × .*Pizza|quán có \d+ món phù hợp với "pizza"/); // the merchant's own ordering
    assert.match(await telegram("menu", u), /Nôm Nôm/);
    assert.equal(provider.calls.length, calls);
    const afterOrdering = { cart: cartItems(), counts: counts() };
    assert.match(await telegram("tìm quán bánh căn ở Nha Trang", u), /📍 Bánh căn Cô Tư/);
    assert.equal(cartItems(), afterOrdering.cart); // discovery again: the cart is untouched
    assert.deepEqual(counts(), afterOrdering.counts);
    assert.equal(afterOrdering.counts[4], before.counts[4]); // no order was created along the way
  });
});

test("UNKNOWN intent: the model may only ask back when it has nothing — it does not invent alternatives", async () => {
  await withGpt([final({ reply: "Dạ anh/chị muốn tìm món gì hoặc ở khu vực nào ạ?", items: [] })], async ({ telegram, logs, provider }) => {
    // FOOD-only scope (2026-09-26): a message with nothing food-like never reaches the model
    assert.match(await telegram("???"), /Em hiện hỗ trợ tìm món ăn, quán ăn/);
    assert.equal(provider.calls.length, 0);
    // a vague FOOD message does: the model asks back instead of inventing alternatives
    assert.equal(await telegram("em đói"), "Dạ anh/chị muốn tìm món gì hoặc ở khu vực nào ạ?");
    assert.equal(logs.at(-1).meta.reason, "discovery");
  });
});

test("OFF: without the concierge the platform is the deterministic one; the factory needs flag + key + model", async () => {
  await withGpt(bunCaNhaTrang(), async ({ telegram, provider }) => {
    assert.match(await telegram("tìm quán bún cá ở Nha Trang"), /Em tìm thấy \d+ quán có dữ liệu phù hợp/);
    assert.equal(provider.calls.length, 0);
  }, { gptEnabled: false });
  const saved = { e: platformConfig.openaiEnabled, k: platformConfig.openaiApiKey, m: platformConfig.openaiModel, pm: platformConfig.foodAgentPrimaryModel, dk: platformConfig.deepseekApiKey };
  try {
    // the OpenAI-only Agent (no primary model; a developer's .env cannot leak DeepSeek in): flag + key + model
    for (const [e, k, m] of [[false, "k", "m"], [true, "", "m"], [true, "k", ""]]) {
      Object.assign(platformConfig, { openaiEnabled: e, openaiApiKey: k, openaiModel: m, foodAgentPrimaryModel: "", deepseekApiKey: "" });
      assert.equal(await createGptFoodConcierge({}), null);
    }
    // DeepSeek primary: still off without the flag, and off with neither the DeepSeek nor the OpenAI key
    for (const [e, k, dk] of [[false, "k", "dk"], [true, "", ""]]) {
      Object.assign(platformConfig, { openaiEnabled: e, openaiApiKey: k, openaiModel: "m", foodAgentPrimaryModel: "deepseek-flash", deepseekApiKey: dk });
      assert.equal(await createGptFoodConcierge({}), null);
    }
  } finally {
    Object.assign(platformConfig, { openaiEnabled: saved.e, openaiApiKey: saved.k, openaiModel: saved.m, foodAgentPrimaryModel: saved.pm, deepseekApiKey: saved.dk });
  }
});
