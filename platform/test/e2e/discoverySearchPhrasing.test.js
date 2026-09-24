// Natural search phrasings through the real router → AgentSearch → Discovery
// → merchant adapter path, against each merchant's authoritative catalog:
// A Tiểu's seeded menu (data/seed/products.json) and, for a generic merchant,
// a menu published through the Menu Import pipeline.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTestPlatform } from "../helpers/testPlatform.js";

function customerCtx(platform) {
  const customer = platform.services.customers.getOrCreateByZaloUserId(`phrasing-${Math.random()}`, "Khách");
  return { customer, session: platform.services.sessions.getOrCreate(customer.id) };
}

async function say(platform, state, text) {
  const result = await platform.router.handle({ customer: state.customer, session: state.session, text });
  state.session = result.session;
  return result;
}

// A generic merchant whose menu comes from the Menu Import pipeline — the
// authoritative path for generic merchants. Imported products carry no
// hand-written keywords, so they are only findable by their name.
function withXaXiuMerchant() {
  const platform = buildTestPlatform({ withAtieu: true, genericFixtureMerchants: ["MERCHANT003"] });
  const draft = platform.services.menuImport.importText("MERCHANT003", "Hủ Tiếu Xá Xíu 55k");
  platform.services.menuImport.approveImport("MERCHANT003", draft.id);
  platform.services.menuImport.publishImport("MERCHANT003", draft.id);
  return platform;
}

test("'tìm cho tôi hủ tiếu xào' finds A Tiểu from its real menu", async () => {
  const platform = buildTestPlatform({ withAtieu: true });
  const r = await say(platform, customerCtx(platform), "tìm cho tôi hủ tiếu xào");
  assert.match(r.replyText, /HỦ TIẾU XÀO A TIỂU/);
  assert.equal(r.searchResultCount, 1);
});

test("A Tiểu's real menu has no xá xíu dish, so 'tìm cho tôi hủ tiếu xá xíu' honestly finds nothing there", async () => {
  const platform = buildTestPlatform({ withAtieu: true });
  const names = platform.atieuCtx.services.menu.listMenu().map((p) => p.name);
  assert.ok(!names.some((n) => /xá xíu/i.test(n)));

  const r = await say(platform, customerCtx(platform), "tìm cho tôi hủ tiếu xá xíu");
  assert.equal(r.searchResultCount, 0);
  assert.match(r.replyText, /chưa tìm thấy quán nào phù hợp/);
});

test("'tìm cho tôi hủ tiếu xá xíu' finds the merchant whose authoritative menu has that dish, and only that merchant", async () => {
  const platform = withXaXiuMerchant();
  const state = customerCtx(platform);
  const r = await say(platform, state, "tìm cho tôi hủ tiếu xá xíu");
  assert.equal(r.searchResultCount, 1);
  assert.match(r.replyText, /MERCHANT 003 \(TEST FIXTURE\)/);
  assert.match(r.replyText, /Hủ Tiếu Xá Xíu/);
  assert.doesNotMatch(r.replyText, /A TIỂU/);
  assert.deepEqual(state.session.lastSearchResults.map((m) => m.merchant_id), ["MERCHANT003"]);
});

test("equivalent phrasings and decomposed (NFD) input reach the same result", async () => {
  const platform = withXaXiuMerchant();
  for (const text of ["hủ tiếu xá xíu", "tìm hủ tiếu xá xíu", "xá xíu", "tìm cho tôi hủ tiếu xá xíu".normalize("NFD")]) {
    const r = await say(platform, customerCtx(platform), text);
    assert.equal(r.searchResultCount, 1, JSON.stringify(text));
    assert.match(r.replyText, /Hủ Tiếu Xá Xíu/, JSON.stringify(text));
  }
});

test("matching was not loosened: an unrelated dish still finds nothing", async () => {
  const platform = withXaXiuMerchant();
  const r = await say(platform, customerCtx(platform), "tìm cho tôi phở gà");
  assert.equal(r.searchResultCount, 0);
});
