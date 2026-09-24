import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTestPlatform } from "../helpers/testPlatform.js";

const GENERIC = "MERCHANT002"; // trial subscription (365 days) from the test fixture

function setup() {
  const platform = buildTestPlatform({ withAtieu: true, genericFixtureMerchants: [GENERIC] });
  const expireTrial = () =>
    platform.db.prepare("UPDATE merchant_subscriptions SET trial_ends_at = datetime('now', '-1 day') WHERE merchant_id = ?").run(GENERIC);
  const customer = platform.services.customers.getOrCreateByZaloUserId(`expiry-${Math.random()}`, "Khách");
  const state = { customer, session: platform.services.sessions.getOrCreate(customer.id) };
  const say = async (text) => {
    const result = await platform.router.handle({ customer: state.customer, session: state.session, text });
    state.session = result.session;
    return result;
  };
  return { platform, expireTrial, say, state };
}

async function discoverableIds(platform, keywords) {
  const { organic, sponsored } = await platform.discovery.searchByKeywords(keywords);
  return [...organic, ...sponsored].map((c) => c.merchant.merchant_id);
}

test("RISK-001: a merchant with a live trial is discoverable", async () => {
  const { platform } = setup();
  assert.ok((await discoverableIds(platform, "hai san")).includes(GENERIC));
});

test("RISK-001: once the trial is over, the merchant is expired and no longer discoverable", async () => {
  const { platform, expireTrial } = setup();
  expireTrial();
  assert.ok(!(await discoverableIds(platform, "hai san")).includes(GENERIC));
  assert.equal(platform.repos.merchants.getById(GENERIC).account_status, "EXPIRED");
  assert.equal(platform.repos.subscriptions.getActiveByMerchant(GENERIC).status, "EXPIRED");
});

test("RISK-001: an expired merchant cannot be opened by name", async () => {
  const { expireTrial, say } = setup();
  expireTrial();
  const r = await say("Xem Merchant 002");
  assert.doesNotMatch(r.replyText, /Đã mở/);
  assert.match(r.replyText, /không khả dụng/);
});

test("RISK-001: a conversation already inside the merchant is routed back out once it expires", async () => {
  const { expireTrial, say, state } = setup();
  const opened = await say("Xem Merchant 002");
  assert.match(opened.replyText, /Đã mở/);
  assert.equal(state.session.active_merchant_id, GENERIC);

  expireTrial();
  const r = await say("Cho tôi 1 hải sản");
  assert.match(r.replyText, /không khả dụng/);
  assert.equal(state.session.context, "platform");
});

test("RISK-001: an expired merchant's cart and order boundary refuses new items", async () => {
  const { platform, expireTrial, state } = setup();
  expireTrial();
  assert.throws(() => platform.services.cart.createCart(state.customer.id, GENERIC), { code: "MERCHANT_NOT_ACTIVE" });
});

test("RISK-001: an active merchant is unaffected — ATIEU001 (no end date) stays discoverable and routable", async () => {
  const { platform, expireTrial, say } = setup();
  expireTrial();
  assert.deepEqual(await discoverableIds(platform, "hủ tiếu xào"), ["ATIEU001"]);
  const opened = await say("Xem A Tiểu");
  assert.match(opened.replyText, /Đã mở/);
  const reply = await say("Cho tôi 1 hủ tiếu xào bò");
  assert.match(reply.replyText, /× 1/);
});
