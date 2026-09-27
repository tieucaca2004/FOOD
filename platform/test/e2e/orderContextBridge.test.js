// FORM 13 — order context bridge. Inside an orderable merchant, "món thứ N" / "món đó" / "giá món đó" are resolved by
// the PLATFORM against the menu the customer was SHOWN (by exact catalog name, per merchant, per session, 30 min), and
// "cho tôi N phần" hands the merchant's OWN ordering engine "<N> <exact dish name>" — the engine still does the ordering.
// A reference-only place is never ordered: FOOD says so, deterministically. "Cho tôi menu của …" opens the place.
// Real webhook, A Tiểu legacy engine + a generic fixture merchant, Agent ON with a model that fails closed (every model
// call is counted: none of these turns may need one), synthetic temp knowledge.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTestPlatform, startServer, baseUrl } from "../helpers/testPlatform.js";
import { nhaTrangKnowledge } from "../helpers/nhaTrangKnowledge.js";
import { createFoodKnowledge } from "../../services/foodKnowledgeAdapter.js";
import { GptFoodConcierge } from "../../ai/foodConcierge/GptFoodConcierge.js";
import { FoodTools } from "../../ai/foodConcierge/foodTools.js";
import { conversationHistory } from "../../ai/index.js";
import { platformConfig } from "../../config.js";

platformConfig.telegramBotToken = "";
const SECRET = "test-telegram-secret-form13";
const MENU = ["Hủ Tiếu Xào Bò", "Hủ Tiếu Xào Hải Sản", "Hủ Tiếu Xào Thập Cẩm", "Hủ Tiếu Xào Đặc Biệt"];

async function start() {
  platformConfig.telegramWebhookSecret = SECRET;
  const calls = [];
  const provider = { model: "gpt-4o", configured: true, respond: async (req) => (calls.push(req), { output: [], functionCalls: [], text: "not json", usage: null }) };
  const file = nhaTrangKnowledge();
  const platform = buildTestPlatform({
    withAtieu: true,
    genericFixtureMerchants: ["MERCHANT002"],
    foodKnowledge: ({ services, merchantRouter }) => createFoodKnowledge({ dbPath: file, services, isRoutable: (m) => merchantRouter.isRoutable(m) }),
    gpt: ({ services, repos, agentSearch, merchantRouter }) => new GptFoodConcierge({ provider, tools: new FoodTools({ services, repos, agentSearch, merchantRouter }), timeoutMs: 5000, maxToolTurns: 4, history: conversationHistory(repos, 6) }),
  });
  const server = await startServer(platform.app);
  let seq = 0;
  const raw = async (u, text) => {
    seq += 1;
    const res = await fetch(`${baseUrl(server)}${platformConfig.telegramWebhookPath}`, { method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": SECRET }, body: JSON.stringify({ update_id: seq, message: { message_id: seq, from: { id: u, first_name: "L" }, chat: { id: u, type: "private" }, date: 1, text } }) });
    assert.equal(res.status, 200);
    return (await res.json()).reply_text;
  };
  /** every turn here must be deterministic: no model call */
  const say = async (u, text) => {
    const n = calls.length;
    const reply = await raw(u, text);
    assert.equal(calls.length, n, `"${text}" needed no model call`);
    return reply;
  };
  const customer = (u) => platform.repos.customers.findByZaloUserId(`telegram:${u}`);
  const session = (u) => platform.repos.sessions.getActiveByCustomer(customer(u).id);
  const atieu = platform.merchantRouter.registry.getAdapter("ATIEU001");
  /** A Tiểu's own cart (its engine's repositories), by dish name */
  const atieuCart = (u) => {
    const c = atieu.services.customers.repos.customers.findByZaloUserId(`platform:${customer(u).id}`);
    const cart = c && atieu.services.cart.repos.carts.getActiveByCustomer(c.id);
    return cart ? atieu.services.cart.repos.carts.listItems(cart.id).map((i) => ({ name: i.product_name, quantity: i.quantity, price: i.unit_price })) : [];
  };
  const stop = () => {
    server.close();
    platform.agentSearch.foodKnowledge.close();
  };
  return { platform, calls, say, raw, session, customer, atieu, atieuCart, stop };
}

test("CASE B: every way to ask for A Tiểu's menu opens A Tiểu's menu (same merchant, no model, no global search)", async () => {
  const d = await start();
  try {
    const wordings = ["menu A Tiểu", "Xem menu A Tiểu", "xem A Tiểu", "Cho tôi menu của A Tiểu", "Cho tôi menu của Hủ Tiếu Xào A Tiểu", "mở menu A Tiểu"];
    for (const [i, t] of wordings.entries()) {
      const reply = await d.say(100 + i, t);
      assert.equal(d.session(100 + i).active_merchant_id, "ATIEU001", `${t}: ${reply.slice(0, 120)}`);
      for (const dish of MENU) assert.match(reply, new RegExp(dish), `${t}: the menu`);
    }
    // a dish name after "menu" is not a place: no place opened
    await d.raw(120, "menu bún cá");
    assert.notEqual(d.session(120).active_merchant_id, "ATIEU001");
  } finally {
    d.stop();
  }
});

test("PRODUCT ORDINALS: 'món thứ 1..4' = the dishes of the menu shown; 'món thứ 5' = out of range", async () => {
  const d = await start();
  try {
    await d.say(200, "menu A Tiểu");
    for (const [i, dish] of MENU.entries()) {
      const r = await d.say(200, `món thứ ${i + 1}`);
      assert.match(r, new RegExp(`^Dạ ${dish}: `), r);
      assert.doesNotMatch(r, new RegExp(MENU.filter((x) => x !== dish).map((x) => `${x}:`).join("|")));
    }
    assert.match(await d.say(200, "món thứ 5"), /menu vừa rồi có 4 món/);
    assert.deepEqual(d.atieuCart(200), [], "choosing a dish orders nothing");
    assert.equal(d.session(200).active_merchant_id, "ATIEU001");
  } finally {
    d.stop();
  }
});

test("ORDER FLOW: menu -> món thứ 2 -> giá món đó (75.000đ, catalog) -> cho tôi 2 phần (cart) -> đặt (checkout)", async () => {
  const d = await start();
  try {
    await d.say(300, "menu A Tiểu");
    assert.match(await d.say(300, "món thứ 2"), /Hủ Tiếu Xào Hải Sản: 75\.000đ/);
    assert.match(await d.say(300, "giá món đó"), /Hủ Tiếu Xào Hải Sản: 75\.000đ/);
    const added = await d.say(300, "cho tôi 2 phần");
    assert.deepEqual(d.atieuCart(300), [{ name: "Hủ Tiếu Xào Hải Sản", quantity: 2, price: 75000 }], added);
    const checkout = await d.say(300, "đặt");
    const state = d.atieu.checkoutState(d.customer(300).id);
    assert.ok(state && (state.field || state.awaitingConfirmation), `checkout started: ${checkout.slice(0, 160)}`);
    assert.deepEqual(d.atieuCart(300), [{ name: "Hủ Tiếu Xào Hải Sản", quantity: 2, price: 75000 }], "merchant / dish / quantity kept");
    assert.equal(d.session(300).active_merchant_id, "ATIEU001");
    // the engine's OWN menu reply is a menu shown too
    await d.say(301, "xem A Tiểu");
    await d.say(301, "menu");
    assert.match(await d.say(301, "món thứ 3"), /^Dạ Hủ Tiếu Xào Thập Cẩm: 60\.000đ/);
    await d.say(301, "lấy 1 phần");
    assert.deepEqual(d.atieuCart(301), [{ name: "Hủ Tiếu Xào Thập Cẩm", quantity: 1, price: 60000 }]);
  } finally {
    d.stop();
  }
});

test("CASE C reference-only: list -> quán thứ 2 -> menu -> 'cho tôi 2 phần' / 'đặt' -> said plainly, nothing ordered, no model", async () => {
  const d = await start();
  try {
    await d.raw(400, "Cho tôi danh sách quán bán bún cá"); // discovery may use the Agent; every turn after is deterministic
    await d.say(400, "quán thứ 2");
    await d.say(400, "menu quán này");
    for (const t of ["cho tôi 2 phần", "đặt"]) {
      const r = await d.say(400, t);
      assert.match(r, /chỉ có thông tin tham khảo, chưa hỗ trợ đặt món qua FOOD/, `${t}: ${r}`);
      assert.equal(d.session(400).context, "platform", "never turned into an orderable merchant");
    }
    assert.deepEqual(d.atieuCart(400), []);
  } finally {
    d.stop();
  }
});

test("MIXED CONTEXT: a catalog dish never leaks into a reference list, merchant A's menu never answers for B, sessions stay apart", async () => {
  const d = await start();
  try {
    // catalog menu -> dish -> back to a reference list -> "món thứ 2" is not A Tiểu's dish
    await d.say(500, "menu A Tiểu");
    await d.say(500, "món thứ 2");
    await d.say(500, "quay lại tổng đài");
    await d.raw(500, "Cho tôi danh sách quán bán bún cá");
    const ref = await d.say(500, "món thứ 2");
    assert.doesNotMatch(ref, /Hủ Tiếu Xào/, ref);
    // merchant A's menu, then merchant B's: "món thứ 2" is B's (it has one dish)
    await d.say(501, "menu A Tiểu");
    await d.say(501, "quay lại tổng đài");
    await d.say(501, "xem Merchant 002");
    assert.equal(d.session(501).active_merchant_id, "MERCHANT002");
    const b2 = await d.say(501, "món thứ 2");
    assert.match(b2, /menu vừa rồi có 1 món/, b2);
    assert.match(await d.say(501, "món thứ 1"), /^Dạ Hủ Tiếu Xào Hải Sản: 72\.000đ/, "B's price, not A's");
    // another customer inside A Tiểu without having seen its menu here: no dish
    await d.say(502, "menu A Tiểu");
    await d.say(502, "món thứ 2");
    await d.say(503, "xem A Tiểu");
    d.platform.repos.sessions.update(d.session(503).id, {}); // same merchant, own session
    const other = await d.say(503, "giá món đó");
    assert.doesNotMatch(other, /Hủ Tiếu Xào Hải Sản: 75/, "not another session's dish");
  } finally {
    d.stop();
  }
});

test("NO MENU / STALE: inside a merchant without a menu shown, or after it expired, a dish reference is asked back", async () => {
  const d = await start();
  try {
    await d.say(600, "xem A Tiểu"); // opens WITH its menu
    const store = d.platform.repos.conversationStates;
    const cid = d.customer(600).id;
    const s = store.getByCustomer(cid);
    assert.ok(s?.menuBridge?.menu, "the menu shown was recorded");
    store.saveForCustomer(cid, { ...s, menuBridge: { ...s.menuBridge, menu: { ...s.menuBridge.menu, touchedAt: "2020-01-01T00:00:00.000Z" } } });
    const r = await d.say(600, "món thứ 2");
    assert.match(r, /xem menu trước/, r);
    assert.deepEqual(d.atieuCart(600), []);
    // "cho tôi 2 phần" with no dish picked: the engine's own question, unchanged
    const q = await d.say(600, "cho tôi 2 phần");
    assert.deepEqual(d.atieuCart(600), [], q);
  } finally {
    d.stop();
  }
});
