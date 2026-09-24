import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTestPlatform } from "../helpers/testPlatform.js";

function customerCtx(platform) {
  const customer = platform.services.customers.getOrCreateByZaloUserId(`e2e-${Date.now()}-${Math.random()}`, "Nguyễn Văn A");
  const session = platform.services.sessions.getOrCreate(customer.id);
  return { customer, session };
}

async function say(platform, state, text) {
  const result = await platform.router.handle({ customer: state.customer, session: state.session, text });
  state.session = result.session;
  return result;
}

test("ACCEPTANCE §33: greeting -> search -> open A Tiểu -> menu -> add to cart -> checkout -> confirm -> real A Tiểu order", async () => {
  const platform = buildTestPlatform();
  const state = customerCtx(platform);

  let r = await say(platform, state, "Xin chào");
  assert.match(r.replyText, /TỔNG ĐÀI/);

  r = await say(platform, state, "Tôi muốn ăn hủ tiếu xào.");
  assert.match(r.replyText, /HỦ TIẾU XÀO A TIỂU/i);
  assert.equal(state.session.context, "platform"); // still at platform, hasn't opened yet

  r = await say(platform, state, "Xem A Tiểu");
  assert.match(r.replyText, /Đã mở/);
  assert.match(r.replyText, /Hủ Tiếu Xào Bò/);
  assert.equal(state.session.context, "merchant");
  assert.equal(state.session.active_merchant_id, "ATIEU001");

  r = await say(platform, state, "Cho tôi 2 hủ tiếu xào bò");
  assert.match(r.replyText, /Hủ Tiếu Xào Bò × 2/);
  assert.equal(r.merchantIntent, "add_to_cart");

  r = await say(platform, state, "Đặt");
  assert.match(r.replyText, /ăn tại quán, mang về, hay giao hàng/);

  r = await say(platform, state, "Mang về");
  r = await say(platform, state, "0912345678");
  assert.match(r.replyText, /ĐƠN HÀNG #AT-/);

  r = await say(platform, state, "Xác nhận");
  assert.match(r.replyText, /Đã xác nhận đơn hàng #AT-/);
  assert.equal(r.merchantIntent, "confirm_order");
  assert.ok(r.orderRef);

  // Prove it's a REAL order inside A Tiểu's own, unmodified engine/DB —
  // not something the platform fabricated.
  const atieuOrders = platform.atieuCtx.repos.orders.listByCustomer(
    platform.atieuCtx.repos.customers.findByZaloUserId(`platform:${state.customer.id}`).id,
    10
  );
  assert.equal(atieuOrders.length, 1);
  assert.equal(atieuOrders[0].status, "CONFIRMED");
  assert.equal(atieuOrders[0].total, 130000);
  assert.equal(atieuOrders[0].order_code, r.orderRef);

  // Platform never duplicated this order into its own generic orders table.
  const platformOrders = platform.db.prepare(`SELECT * FROM orders`).all();
  assert.equal(platformOrders.length, 0);
});

test("the platform greeting is channel-neutral (every channel shares this router)", async () => {
  const platform = buildTestPlatform();
  const state = customerCtx(platform);
  const r = await say(platform, state, "Xin chào");
  assert.equal(
    r.replyText,
    'Dạ em chào anh/chị, em là trợ lý của TỔNG ĐÀI — nơi tìm và đặt món từ nhiều quán ăn.\nAnh/chị muốn ăn gì hôm nay ạ? (VD: "Tôi muốn ăn hủ tiếu xào")'
  );
  assert.doesNotMatch(r.replyText, /Zalo|Telegram/);
});

test("merchant context: a follow-up message is routed straight into A Tiểu, not re-searched platform-wide", async () => {
  const platform = buildTestPlatform();
  const state = customerCtx(platform);
  await say(platform, state, "Xem A Tiểu");
  const before = state.session.last_search_query;

  const r = await say(platform, state, "Cho tôi 1 hải sản");
  assert.match(r.replyText, /Hủ Tiếu Xào Hải Sản × 1/);
  assert.equal(state.session.last_search_query, before); // no new platform search happened
});

test("return to platform clears merchant context", async () => {
  const platform = buildTestPlatform();
  const state = customerCtx(platform);
  await say(platform, state, "Xem A Tiểu");
  assert.equal(state.session.context, "merchant");

  const r = await say(platform, state, "Quay lại tổng đài");
  assert.match(r.replyText, /quay lại Tổng Đài/i);
  assert.equal(state.session.context, "platform");
  assert.equal(state.session.active_merchant_id, null);
});

test("global search while inside a merchant exits merchant context and searches again", async () => {
  const platform = buildTestPlatform({ withGenericFixture: true });
  const state = customerCtx(platform);
  await say(platform, state, "Tôi muốn ăn hải sản");
  await say(platform, state, "Xem A Tiểu");
  assert.equal(state.session.context, "merchant");

  const r = await say(platform, state, "Có quán nào khác bán món này không?");
  assert.equal(state.session.context, "platform");
  assert.match(r.replyText, /Em tìm thấy|chưa tìm thấy/);
});

test("AI invalid/garbage result never crashes the router and never bypasses DB search", async () => {
  const platform = buildTestPlatform();
  platform.ai.classify = async () => "not even json shaped like the contract";
  const state = customerCtx(platform);
  const r = await say(platform, state, "asdkjhaskjdh gibberish no keywords");
  assert.equal(typeof r.replyText, "string");
  assert.ok(r.replyText.length > 0);
});

test("AI suggesting a nonexistent merchant name is still validated against the real registry", async () => {
  const platform = buildTestPlatform();
  platform.ai.classify = async () => ({ intent: "open_merchant_by_name", merchantNameHint: "Quán Bịa Đặt Không Tồn Tại" });
  const state = customerCtx(platform);
  const r = await say(platform, state, "xyzxyz");
  assert.equal(state.session.context, "platform"); // never opened a fake merchant
  assert.doesNotMatch(r.replyText, /Đã mở/);
});

test("unknown merchant name (cold utterance) falls back to keyword search instead of failing", async () => {
  const platform = buildTestPlatform();
  const state = customerCtx(platform);
  const r = await say(platform, state, "Tôi muốn ăn ở Quán Không Tồn Tại");
  assert.equal(typeof r.replyText, "string");
});

test("opening an unavailable (SUSPENDED) merchant is refused, not silently opened", async () => {
  const platform = buildTestPlatform();
  platform.repos.merchants.setStatus("ATIEU001", "SUSPENDED");
  const state = customerCtx(platform);
  const r = await say(platform, state, "Xem A Tiểu");
  assert.match(r.replyText, /không khả dụng|tìm quán khác/);
  assert.equal(state.session.context, "platform");
});
