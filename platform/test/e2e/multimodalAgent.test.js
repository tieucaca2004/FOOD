// FORM 15 — a customer's PHOTO is a conversational message for the FOOD Agent:
//   Telegram / Zalo image update -> the REAL channel controller -> the existing normaliser (inboundMessage.js)
//   -> the existing media fetcher (fixture bytes) -> customerImageEvidence (checkImage + image reader + imageFindings)
//   -> UNVERIFIED evidence in the Agent's CONTEXT -> the Agent (scripted model here; real GPT-4o in the isolated
//   live harness) -> tools -> Fact Guard -> the reply the channel sends.
// Real image bytes (platform/test/fixtures/multimodal); the reader returns the recorded readings of those images.
// Customer contributions are OFF (the default): image conversation does not depend on them.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { buildTestPlatform, startServer, baseUrl } from "../helpers/testPlatform.js";
import { nhaTrangKnowledge } from "../helpers/nhaTrangKnowledge.js";
import { FixtureImageUnderstanding, fixture, fixtureFetcher } from "../helpers/contributionKit.js";
import { createFoodKnowledge } from "../../services/foodKnowledgeAdapter.js";
import { customerImageEvidence } from "../../services/knowledgeIngestAdapter.js";
import { createImageConversation } from "../../services/imageConversation.js";
import { GptFoodConcierge } from "../../ai/foodConcierge/GptFoodConcierge.js";
import { FoodTools } from "../../ai/foodConcierge/foodTools.js";
import { FOOD_CONCIERGE_INSTRUCTIONS } from "../../ai/foodConcierge/systemPrompt.js";
import { conversationHistory, customerImageMemory } from "../../ai/index.js";
import { platformConfig } from "../../config.js";

platformConfig.telegramBotToken = "";
const SECRET = "test-telegram-secret-form15";
const IMAGE_NOT_READ = /đã nhận được ảnh của anh\/chị, nhưng hiện em chưa trả lời được về ảnh này/;

// ------------------------------------------------------------------ scripted FOOD Agent model
const ctxOf = (req) => JSON.parse(String(req.input[0].content).match(/CONTEXT (\{.*\})\nCUSTOMER:/s)[1]);
const customerSaid = (req) => String(req.input[0].content).split("CUSTOMER: ").pop();
const outs = (req) => req.input.filter((i) => i.type === "function_call_output").map((o) => JSON.parse(o.output));
const answer = (reply, items = []) => ({ output: [], functionCalls: [], text: JSON.stringify({ reply, items }), usage: null });
let callN = 0;
const call = (name, args) => {
  const id = `c${++callN}`;
  const item = { type: "function_call", call_id: id, name, arguments: JSON.stringify(args) };
  return { output: [item], functionCalls: [{ callId: id, name, arguments: item.arguments }], text: "", usage: null };
};
/** a model that says what the photo shows, attributed to the customer's photo */
const photoReader = (req) => {
  const img = ctxOf(req).customer_image;
  if (!img) return answer("Dạ, anh/chị cần tìm món gì ạ?");
  if (img.status !== "read") return answer("Dạ em chưa đọc được ảnh anh/chị gửi, anh/chị cần tìm món hoặc quán nào ạ?");
  if (img.items?.length) return answer(`Dạ, ảnh anh/chị gửi có ghi ${img.items.map((i) => `${i.name}${i.price_text ? ` ${i.price_text}` : ""}`).join(", ")} ạ.`);
  if (img.place_name) return answer(`Dạ, ảnh anh/chị gửi có ghi tên quán ${img.place_name} ạ.`);
  return answer("Dạ, em chưa thấy chữ nào đọc được rõ trong ảnh anh/chị gửi ạ.");
};

async function start({ script = photoReader, reader = new FixtureImageUnderstanding(), fetchTelegram = fixtureFetcher(), fetchZalo = null, agent = true, readTimeoutMs = 5000, provider = null } = {}) {
  platformConfig.telegramWebhookSecret = SECRET;
  const calls = [];
  const model = provider ?? { model: "gpt-4o", configured: true, respond: async (req) => (calls.push({ ...req, input: [...req.input] }), script(req)) };
  const turns = [];
  const logger = { info: (c, m, meta) => (m === "gpt concierge turn" ? turns.push(meta) : null), warn() {}, error() {} };
  const zalo = fetchZalo ?? (async (url) => fixtureFetcher()(new URL(url).pathname.slice(1)));
  const platform = buildTestPlatform({
    withAtieu: true,
    foodKnowledge: ({ services, merchantRouter }) => createFoodKnowledge({ dbPath: nhaTrangKnowledge(), services, isRoutable: (m) => merchantRouter.isRoutable(m) }),
    ...(agent && { gpt: ({ services, repos, agentSearch, merchantRouter }) => new GptFoodConcierge({ provider: model, tools: new FoodTools({ services, repos, agentSearch, merchantRouter }), logger, timeoutMs: 5000, maxToolTurns: 4, history: conversationHistory(repos, 6), imageMemory: customerImageMemory(repos) }) }),
  });
  // the service the server builds with the Agent (server.js): existing fetchers + existing reader + customerImageEvidence
  platform.router.images = createImageConversation({ fetchTelegram, fetchZalo: zalo, readEvidence: customerImageEvidence, reader, readTimeoutMs });
  const server = await startServer(platform.app);
  let seq = 0;
  const post = async (path, body) => {
    const res = await fetch(`${baseUrl(server)}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": SECRET }, body: JSON.stringify(body) });
    return { http: res.status, body: await res.json() };
  };
  /** a real Telegram photo update: photo sizes (+ caption), or an image document */
  const telegramPhoto = (user, file, { caption = null, document = false } = {}) => {
    seq += 1;
    const media = document ? { document: { file_id: file, mime_type: file.endsWith(".png") ? "image/png" : "image/jpeg", file_size: fixture(file).length } } : { photo: [{ file_id: `thumb-${file}`, width: 90, height: 90, file_size: 900 }, { file_id: file, width: 1280, height: 960, file_size: fixture(file).length }] };
    return post(platformConfig.telegramWebhookPath, { update_id: 900000 + seq, message: { message_id: seq, from: { id: user, first_name: "L" }, chat: { id: user, type: "private" }, date: 1, ...media, ...(caption && { caption }) } });
  };
  const telegramText = (user, text) => {
    seq += 1;
    return post(platformConfig.telegramWebhookPath, { update_id: 900000 + seq, message: { message_id: seq, from: { id: user, first_name: "L" }, chat: { id: user, type: "private" }, date: 1, text } });
  };
  /** a real Zalo OA user_send_image event */
  const zaloImage = (user, file, text = null) => {
    seq += 1;
    return post(platformConfig.webhookPath, { event_name: "user_send_image", sender: { id: `zalo-${user}` }, message: { msg_id: `zimg-${seq}`, ...(text && { text }), attachments: [{ type: "image", payload: { url: `https://zdn.vn/${file}`, thumbnail: `https://zdn.vn/t-${file}` } }] }, timestamp: Date.now() });
  };
  const stop = () => {
    server.close();
    platform.agentSearch.foodKnowledge.close();
  };
  return { platform, calls, turns, reader, fetchTelegram, telegramPhoto, telegramText, zaloImage, stop };
}

test("1 / 16 IMAGE ONLY (no caption) reaches the FOOD Agent with the photo's evidence; the reply is the Agent's", async () => {
  const d = await start();
  try {
    const { http, body } = await d.telegramPhoto(1001, "menu_clean.jpg");
    assert.equal(http, 200);
    assert.equal(body.status, "processed", "never 'ignored'");
    assert.equal(d.calls.length >= 1, true, "the Agent was called");
    const ctx = ctxOf(d.calls[0]);
    assert.equal(customerSaid(d.calls[0]), "(khách chỉ gửi ảnh, không kèm chữ)");
    assert.equal(ctx.customer_image.this_turn, true);
    assert.equal(ctx.customer_image.status, "read");
    assert.equal(ctx.customer_image.document_type, "MENU");
    assert.match(ctx.customer_image.trust, /UNTRUSTED/);
    assert.match(body.reply_text, /^Dạ, ảnh anh\/chị gửi có ghi Bún bò Huế 45K/, body.reply_text);
    assert.equal(d.turns.at(-1).mode, "gpt", "the Agent's answer passed the Fact Guard and is the reply");
    assert.deepEqual(d.turns.at(-1).image, { thisTurn: true, status: "read", documentType: "MENU", items: 4 });
  } finally {
    d.stop();
  }
});

test("2 IMAGE + CAPTION: the Agent receives both — the caption as the customer's words, the photo as evidence", async () => {
  const d = await start();
  try {
    const { body } = await d.telegramPhoto(1002, "menu_clean.jpg", { caption: "Quán này có món gì?" });
    assert.equal(body.status, "processed");
    assert.equal(customerSaid(d.calls[0]), "Quán này có món gì?");
    assert.equal(ctxOf(d.calls[0]).customer_image.status, "read");
    assert.match(body.reply_text, /Bún bò Huế/);
  } finally {
    d.stop();
  }
});

test("3 TEXT ONLY is unchanged: no image evidence, no image read, same text path", async () => {
  const d = await start();
  try {
    const { body } = await d.telegramText(1003, "bún cá ở đâu");
    assert.equal(body.status, "processed");
    assert.equal(d.reader.calls, 0);
    for (const c of d.calls) assert.equal(ctxOf(c).customer_image, undefined);
  } finally {
    d.stop();
  }
});

test("4 / 5 MENU and PRICE BOARD photos: the visible dishes and prices, evidence-first (only what the image text shows)", async () => {
  const d = await start();
  try {
    await d.telegramPhoto(1004, "menu_clean.jpg");
    const menu = ctxOf(d.calls.at(-1)).customer_image;
    assert.deepEqual(menu.items.map((i) => [i.name, i.price_text]), [["Bún bò Huế", "45K"], ["Bánh hỏi", "40.000đ"], ["Bún chả", "50K"], ["Trà đá", "5K"]]);
    const board = await d.telegramPhoto(1005, "price_board.jpg");
    const prices = ctxOf(d.calls.at(-1)).customer_image;
    assert.equal(prices.document_type, "PRICE_BOARD");
    assert.deepEqual(prices.items.map((i) => [i.name, i.price_text]), [["Phở bò", "50.000đ"], ["Phở gà", "45.000đ"]]);
    assert.match(board.body.reply_text, /Phở bò 50\.000đ, Phở gà 45\.000đ/);
    const sign = await d.telegramPhoto(1006, "merchant_sign.jpg");
    assert.match(sign.body.reply_text, /tên quán/, sign.body.reply_text);
  } finally {
    d.stop();
  }
});

test("6 PHOTO vs CATALOG: the Agent answers with the catalog price (75.000đ) and says the photo shows 65K; the photo price is never FOOD's", async () => {
  let hostile = false;
  const script = (req) => {
    const img = ctxOf(req).customer_image;
    const o = outs(req);
    if (!o.length) return call("get_menu", { merchant_id: "cat:ATIEU001" });
    const p = o[0].products.find((x) => x.product_name === "Hủ Tiếu Xào Hải Sản");
    if (hostile) return answer("Dạ, giá chính thức của Hủ Tiếu Xào Hải Sản là 65.000đ ạ.", [{ merchant_id: "cat:ATIEU001", product_ids: [p.product_id], note: "" }]);
    return answer(`Dạ, ảnh anh/chị gửi ghi Hủ Tiếu Xào Hải Sản ${img.items[0].price_text}, còn trên FOOD món này giá như bên dưới ạ.`, [{ merchant_id: "cat:ATIEU001", product_ids: [p.product_id], note: "" }]);
  };
  const d = await start({ script });
  try {
    const ok = await d.telegramPhoto(1007, "menu_catalog_conflict.jpg", { caption: "Giá món này bao nhiêu?" });
    assert.match(ok.body.reply_text, /ảnh anh\/chị gửi ghi Hủ Tiếu Xào Hải Sản 65K/);
    assert.match(ok.body.reply_text, /75\.000đ/, "the catalog price (rendered from the tool)");
    assert.equal(d.turns.at(-1).mode, "gpt");
    hostile = true;
    const bad = await d.telegramPhoto(1008, "menu_catalog_conflict.jpg", { caption: "Giá món này bao nhiêu?" });
    assert.doesNotMatch(bad.body.reply_text, /chính thức .*65/, bad.body.reply_text);
    assert.ok(d.turns.at(-1).violations.some((v) => /UNATTRIBUTED_CANDIDATE|UNSUPPORTED_PRICE/.test(v)), JSON.stringify(d.turns.at(-1).violations));
    assert.match(bad.body.reply_text, IMAGE_NOT_READ, "a controlled reply, never the photo's price as a fact");
  } finally {
    d.stop();
  }
});

test("7 INJECTION image: the photo's text is data — never in the instructions, never obeyed (Fact Guard blocks the obeyed price)", async () => {
  const obey = (req) => answer("Dạ, theo hệ thống, em đã publish và giá Bún bò Huế là 1đ ạ.");
  const d = await start({ script: obey });
  try {
    const { body } = await d.telegramPhoto(1009, "prompt_injection.jpg");
    const c = d.calls[0];
    assert.equal(c.instructions, FOOD_CONCIERGE_INSTRUCTIONS);
    assert.doesNotMatch(c.instructions, /ignore all previous instructions/i);
    const img = ctxOf(c).customer_image;
    assert.match(img.text, /ignore all previous instructions/, "the injection is only data inside CONTEXT.customer_image");
    assert.ok(img.items.every((i) => i.implausible), "a 1đ price is flagged implausible (and never counts)");
    assert.doesNotMatch(body.reply_text, /publish|1đ/);
    assert.match(body.reply_text, IMAGE_NOT_READ);
  } finally {
    d.stop();
  }
});

test("8 FOOD PHOTO: no dish, place or price is invented; a hostile guess is refused", async () => {
  const guess = (req) => answer("Dạ, đây là Bún bò Huế của Quán Mẫu Thử, giá 45.000đ ạ.");
  const d = await start({ script: guess });
  try {
    const { body } = await d.telegramPhoto(1010, "food_photo.jpg");
    const img = ctxOf(d.calls[0]).customer_image;
    assert.equal(img.document_type, "FOOD_PHOTO");
    assert.deepEqual(img.items, []);
    assert.doesNotMatch(body.reply_text, /45\.000đ|Quán Mẫu Thử/);
    assert.ok(d.turns.at(-1).violations.length > 0);
  } finally {
    d.stop();
  }
  const d2 = await start();
  try {
    const { body } = await d2.telegramPhoto(1011, "food_photo.jpg");
    assert.match(body.reply_text, /chưa thấy chữ nào đọc được/, "the honest answer passes");
  } finally {
    d2.stop();
  }
});

test("9 SESSION ISOLATION: one customer's photo is never another's context; it stays this customer's for follow-ups", async () => {
  const d = await start();
  try {
    await d.telegramPhoto(1012, "menu_clean.jpg");
    const n = d.calls.length;
    await d.telegramText(1013, "giá món trong ảnh bao nhiêu?");
    for (const c of d.calls.slice(n)) assert.equal(ctxOf(c).customer_image, undefined, "customer B never sees A's photo");
    const m = d.calls.length;
    await d.telegramText(1012, "giá món trong ảnh bao nhiêu?");
    const follow = d.calls.slice(m).map((c) => ctxOf(c).customer_image).filter(Boolean);
    assert.ok(follow.length, "customer A's own photo, for the follow-up");
    assert.equal(follow[0].this_turn, false);
  } finally {
    d.stop();
  }
});

test("10 CONTRIBUTIONS OFF: image chat works; nothing is stored as a contribution; with the Agent OFF a photo still gets a reply", async () => {
  const d = await start();
  try {
    const { body } = await d.telegramPhoto(1014, "menu_clean.jpg");
    assert.equal(body.status, "processed");
    assert.match(body.reply_text, /Bún bò Huế/);
  } finally {
    d.stop();
  }
  // production today: OPENAI_ENABLED=false -> no Agent -> a plain reply (never the old silent "ignored")
  const off = await start({ agent: false });
  try {
    for (const r of [await off.telegramPhoto(1015, "menu_clean.jpg"), await off.zaloImage(1015, "menu_clean.jpg")]) {
      assert.equal(r.body.status, "processed");
      assert.match(r.body.reply_text, IMAGE_NOT_READ);
    }
    assert.equal(off.reader.calls, 0, "no image is read without the Agent");
  } finally {
    off.stop();
  }
});

test("11 TELEGRAM normalisation: the largest photo size, an image document, the caption — through the real controller", async () => {
  const d = await start();
  try {
    await d.telegramPhoto(1016, "menu_clean.jpg", { caption: "đây là menu" });
    assert.deepEqual(d.fetchTelegram.calls.slice(-1), ["menu_clean.jpg"], "the largest size, not the thumbnail");
    await d.telegramPhoto(1017, "menu_small.png", { document: true });
    assert.equal(d.fetchTelegram.calls.at(-1), "menu_small.png");
    assert.equal(ctxOf(d.calls.at(-1)).customer_image.status, "read");
    const logged = d.platform.repos.messages.recentForSession(d.platform.repos.sessions.getActiveByCustomer(d.platform.repos.customers.findByZaloUserId("telegram:1016").id).id, 5);
    assert.ok(logged.some((m) => m.direction === "in" && /^\[ảnh\] đây là menu$/.test(m.rawText)));
  } finally {
    d.stop();
  }
});

test("12 ZALO user_send_image -> the real Zalo controller -> fetch by URL -> Agent -> reply", async () => {
  const urls = [];
  const d = await start({ fetchZalo: async (url) => (urls.push(url), fixtureFetcher()(new URL(url).pathname.slice(1))) });
  try {
    const { body } = await d.zaloImage(1018, "price_board.jpg", "giá ở đây sao?");
    assert.equal(body.status, "processed");
    assert.deepEqual(urls, ["https://zdn.vn/price_board.jpg"]);
    assert.equal(customerSaid(d.calls[0]), "giá ở đây sao?");
    assert.match(body.reply_text, /Phở bò 50\.000đ/);
  } finally {
    d.stop();
  }
});

test("13 MEDIA CLEANUP: the image is read in memory only — nothing is written to disk, nothing is stored", async () => {
  const d = await start();
  const size = fixture("menu_clean.jpg").length;
  const written = [];
  const spy = (name, orig) => (...args) => {
    const data = args[1];
    if (Buffer.isBuffer(data) || data instanceof Uint8Array || /\.(jpe?g|png|webp)$/i.test(String(args[0]))) written.push({ name, path: String(args[0]), bytes: data?.length ?? null });
    return orig(...args);
  };
  const saved = { writeFileSync: fs.writeFileSync, writeFile: fs.writeFile, copyFileSync: fs.copyFileSync, promisesWriteFile: fs.promises.writeFile };
  fs.writeFileSync = spy("writeFileSync", saved.writeFileSync);
  fs.writeFile = spy("writeFile", saved.writeFile);
  fs.copyFileSync = spy("copyFileSync", saved.copyFileSync);
  fs.promises.writeFile = spy("promises.writeFile", saved.promisesWriteFile);
  try {
    const { body } = await d.telegramPhoto(1019, "menu_clean.jpg");
    assert.equal(body.status, "processed");
  } finally {
    Object.assign(fs, { writeFileSync: saved.writeFileSync, writeFile: saved.writeFile, copyFileSync: saved.copyFileSync });
    fs.promises.writeFile = saved.promisesWriteFile;
    d.stop();
  }
  assert.deepEqual(written.filter((w) => w.bytes === size || /\.(jpe?g|png|webp)$/i.test(w.path)), [], JSON.stringify(written));
  const memo = d.platform.repos.conversationStates.getByCustomer(d.platform.repos.customers.findByZaloUserId("telegram:1019").id).lastImage;
  assert.ok(memo && !JSON.stringify(memo).includes(fixture("menu_clean.jpg").toString("base64").slice(0, 40)), "the remembered evidence holds no image bytes");
});

test("14 VISION / DOWNLOAD FAILURE: the Agent is told the photo could not be read and answers; the webhook never fails", async () => {
  const cases = {
    vision_failed: { reader: new FixtureImageUnderstanding({ fail: () => new Error("model down") }) },
    vision_timeout: { reader: new FixtureImageUnderstanding({ delayMs: 400 }), readTimeoutMs: 50 },
    download_failed: { fetchTelegram: fixtureFetcher({ fail: () => new Error("HTTP 404") }) },
    unreadable: { file: "not_an_image.jpg" },
  };
  for (const [reason, opts] of Object.entries(cases)) {
    const d = await start(opts);
    try {
      const { http, body } = await d.telegramPhoto(1020, opts.file ?? "menu_clean.jpg");
      assert.equal(http, 200);
      const img = ctxOf(d.calls[0]).customer_image;
      assert.notEqual(img.status, "read", reason);
      if (reason !== "unreadable") assert.equal(img.reason, reason);
      assert.match(body.reply_text, /chưa đọc được ảnh anh\/chị gửi/, `${reason}: ${body.reply_text}`);
    } finally {
      d.stop();
    }
  }
});

test("15 AGENT FAILURE: the provider is down -> a controlled reply on both channels, never silence, never a crash", async () => {
  const down = { model: "gpt-4o", configured: true, respond: async () => Promise.reject(Object.assign(new Error("ENOTFOUND"), { kind: "network" })) };
  const d = await start({ provider: down });
  try {
    for (const r of [await d.telegramPhoto(1021, "menu_clean.jpg"), await d.zaloImage(1021, "menu_clean.jpg")]) {
      assert.equal(r.http, 200);
      assert.equal(r.body.status, "processed");
      assert.match(r.body.reply_text, IMAGE_NOT_READ);
    }
  } finally {
    d.stop();
  }
});

test("16b the image service never writes a reply: it returns evidence only", async () => {
  const svc = createImageConversation({ fetchTelegram: fixtureFetcher(), readEvidence: customerImageEvidence, reader: new FixtureImageUnderstanding() });
  const ev = await svc.read({ channel: "telegram", messageId: "1", attachments: [{ type: "image", ref: "menu_clean.jpg", mimeType: "image/jpeg" }] });
  assert.equal(ev.status, "read");
  assert.equal(ev.trust, "UNVERIFIED");
  for (const k of ["reply", "replyText", "reply_text", "answer"]) assert.equal(ev[k], undefined);
  assert.equal(await svc.read({ channel: "telegram", attachments: [] }), null);
});
