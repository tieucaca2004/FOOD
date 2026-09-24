// /api/platform/search is public by design. It may return only public
// catalogue data for discoverable merchants: never contact details, keys,
// subscription dates, customers or orders, and never a merchant that is
// pending, suspended, expired or closed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTestPlatform, startServer, baseUrl } from "../helpers/testPlatform.js";

const MERCHANT_FIELDS = ["matches", "merchant_id", "merchant_name", "merchant_status", "score"];
const MATCH_FIELDS = ["available", "matchQuality", "name", "price", "productId"];
const PHONE = "0909000111";

async function withSearch(fn) {
  const platform = buildTestPlatform({ withAtieu: true, genericFixtureMerchants: ["MERCHANT002", "MERCHANT003"] });
  platform.db.prepare("UPDATE merchants SET phone = ? WHERE merchant_id IN ('MERCHANT002', 'MERCHANT003')").run(PHONE);
  const apiKey = platform.services.merchantAuth.issueApiKey("MERCHANT002").apiKey;
  const server = await startServer(platform.app);
  const search = async (q) => {
    const res = await fetch(`${baseUrl(server)}/api/platform/search?q=${encodeURIComponent(q)}`);
    const text = await res.text();
    return { status: res.status, text, body: JSON.parse(text) };
  };
  try {
    return await fn({ platform, search, apiKey });
  } finally {
    server.close();
  }
}

test("search returns only whitelisted public catalogue fields", async () => {
  await withSearch(async ({ search }) => {
    const res = await search("hủ tiếu");
    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(res.body).sort(), ["organic", "sponsored"]);
    const all = [...res.body.organic, ...res.body.sponsored];
    assert.ok(all.length >= 2);
    for (const merchant of all) {
      assert.deepEqual(Object.keys(merchant).sort(), MERCHANT_FIELDS);
      assert.ok(["ACTIVE", "TRIAL"].includes(merchant.merchant_status));
      for (const match of merchant.matches) assert.deepEqual(Object.keys(match).sort(), MATCH_FIELDS);
    }
  });
});

test("search never includes contact details, credentials, subscription dates, customers or orders", async () => {
  await withSearch(async ({ platform, search, apiKey }) => {
    const customer = platform.services.customers.getOrCreateByZaloUserId("search-exposure-customer", "Khách Bí Mật");
    const cart = platform.services.cart.createCart(customer.id, "MERCHANT002");
    const product = platform.services.menu.listProducts("MERCHANT002")[0];
    platform.services.cart.addItem(customer.id, cart.id, "MERCHANT002", product.id, 1);
    const order = await platform.services.orders.confirmOrder(customer.id, cart.id);
    const hash = platform.db.prepare("SELECT api_key_hash FROM merchant_users WHERE merchant_id = 'MERCHANT002'").get().api_key_hash;

    const { text } = await search("hủ tiếu");
    for (const secret of [PHONE, "Nha Trang", apiKey, hash, "Khách Bí Mật", order.order_code, "search-exposure-customer"]) {
      assert.ok(!text.includes(secret), `search leaked ${secret.slice(0, 12)}`);
    }
    assert.doesNotMatch(text, /api_key|trial_ends_at|expires_at|subscription|phone|address|customer|order_code/i);
  });
});

test("only discoverable merchants appear: pending, suspended, expired and closed ones never do", async () => {
  await withSearch(async ({ platform, search }) => {
    const ids = async () => (await search("hủ tiếu")).body.organic.map((m) => m.merchant_id).sort();
    assert.deepEqual(await ids(), ["ATIEU001", "MERCHANT002", "MERCHANT003"]);

    platform.services.merchants.suspend("MERCHANT003");
    assert.deepEqual(await ids(), ["ATIEU001", "MERCHANT002"]);
    platform.services.merchants.close("MERCHANT002");
    assert.deepEqual(await ids(), ["ATIEU001"]);

    platform.services.merchants.activate("MERCHANT003");
    platform.db.prepare("UPDATE merchant_subscriptions SET trial_ends_at = datetime('now','-1 day') WHERE merchant_id = 'MERCHANT003'").run();
    assert.deepEqual(await ids(), ["ATIEU001"]); // expired at read time

    platform.services.merchants.onboard({ merchantId: "PENDSEARCH1", name: "Hủ Tiếu Chờ Duyệt", slug: "hu-tieu-cho-duyet", module: "generic" });
    assert.ok(!(await search("hủ tiếu chờ duyệt")).text.includes("PENDSEARCH1"));
  });
});

test("a merchant whose menu is not published exposes no dishes", async () => {
  await withSearch(async ({ platform, search }) => {
    platform.services.menu.createMenu("MERCHANT002", { name: "Draft menu" });
    const body = (await search("hủ tiếu")).body;
    assert.ok(!body.organic.some((m) => m.merchant_id === "MERCHANT002"));
  });
});

test("wildcard-shaped and oversized queries are handled safely", async () => {
  await withSearch(async ({ search }) => {
    for (const q of ["%", "_", "%' OR 1=1 --", "a".repeat(4000)]) {
      const res = await search(q);
      assert.equal(res.status, 200, q.slice(0, 10));
      assert.deepEqual(res.body.organic, [], q.slice(0, 10));
    }
    const empty = await search("");
    assert.equal(empty.status, 400);
  });
});
