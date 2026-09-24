// activate() is the admin review/resume step; it must not bring back a
// merchant whose subscription has expired. Reactivating an expired merchant
// is renew() (spec §43), which leaves subscription and account consistent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTestPlatform, startServer, baseUrl, ADMIN_AUTH_HEADER } from "../helpers/testPlatform.js";

function setup() {
  const platform = buildTestPlatform({ withAtieu: true, genericFixtureMerchants: ["MERCHANT002"] });
  const discoverable = (id) => platform.services.merchantData.listDiscoverable().some((m) => m.merchant_id === id);
  const subscription = (id) => platform.repos.subscriptions.getActiveByMerchant(id);
  const status = (id) => platform.repos.merchants.getById(id).status;
  const endTrial = (id) =>
    platform.db.prepare("UPDATE merchant_subscriptions SET trial_ends_at = datetime('now','-1 day') WHERE merchant_id = ?").run(id);
  return { platform, discoverable, subscription, status, endTrial };
}

test("activate() refuses a merchant whose subscription has expired, and the merchant stays expired", () => {
  const { platform, discoverable, subscription, status, endTrial } = setup();
  endTrial("MERCHANT002");
  assert.equal(discoverable("MERCHANT002"), false); // read-time expiry flips both
  assert.equal(subscription("MERCHANT002").status, "EXPIRED");

  assert.throws(() => platform.services.merchants.activate("MERCHANT002"), (err) => err.code === "SUBSCRIPTION_EXPIRED");
  assert.equal(status("MERCHANT002"), "EXPIRED");
  assert.equal(discoverable("MERCHANT002"), false);
});

test("activate() refuses a merchant whose trial has ended but has not been marked expired yet", () => {
  const { platform, discoverable, status, endTrial } = setup();
  endTrial("MERCHANT002"); // no read has run expiry yet
  assert.throws(() => platform.services.merchants.activate("MERCHANT002"), (err) => err.code === "SUBSCRIPTION_EXPIRED");
  assert.notEqual(status("MERCHANT002"), "ACTIVE");
  assert.equal(discoverable("MERCHANT002"), false);
});

test("activate() refuses a suspended merchant whose subscription expired while suspended", () => {
  const { platform, discoverable, endTrial } = setup();
  platform.services.merchants.suspend("MERCHANT002");
  endTrial("MERCHANT002");
  assert.throws(() => platform.services.merchants.activate("MERCHANT002"), (err) => err.code === "SUBSCRIPTION_EXPIRED");
  assert.equal(discoverable("MERCHANT002"), false);
});

test("renew() is the way back: after renewal the merchant is active and discoverable, and activate() is allowed again", () => {
  const { platform, discoverable, subscription, status, endTrial } = setup();
  endTrial("MERCHANT002");
  assert.equal(discoverable("MERCHANT002"), false);
  platform.services.subscriptions.renew("MERCHANT002", new Date(Date.now() + 30 * 86400000).toISOString());
  assert.equal(subscription("MERCHANT002").status, "ACTIVE");
  assert.equal(status("MERCHANT002"), "ACTIVE");
  assert.equal(discoverable("MERCHANT002"), true);

  platform.services.merchants.suspend("MERCHANT002");
  platform.services.merchants.activate("MERCHANT002");
  assert.equal(discoverable("MERCHANT002"), true);
});

test("unchanged: activate() still approves a pending merchant on a live trial and resumes a suspended one", () => {
  const { platform, discoverable, status } = setup();
  platform.services.merchants.onboard({ merchantId: "PENDING001", name: "Pending", slug: "pending-001", module: "generic" });
  assert.equal(status("PENDING001"), "PENDING");
  platform.services.merchants.activate("PENDING001");
  assert.equal(status("PENDING001"), "TRIAL");

  platform.services.merchants.suspend("MERCHANT002");
  assert.equal(discoverable("MERCHANT002"), false);
  platform.services.merchants.activate("MERCHANT002");
  assert.equal(discoverable("MERCHANT002"), true);
});

test("unchanged: a merchant with an open-ended subscription (ATIEU001) can be suspended and resumed", () => {
  const { platform, discoverable } = setup();
  platform.services.merchants.suspend("ATIEU001");
  assert.equal(discoverable("ATIEU001"), false);
  platform.services.merchants.activate("ATIEU001");
  assert.equal(discoverable("ATIEU001"), true);
});

test("the admin API reports the refusal as a 400 with code SUBSCRIPTION_EXPIRED", async () => {
  const { platform, status, endTrial } = setup();
  endTrial("MERCHANT002");
  const server = await startServer(platform.app);
  try {
    const res = await fetch(`${baseUrl(server)}/api/platform/merchants/MERCHANT002/status`, {
      method: "PATCH",
      headers: { "content-type": "application/json", ...ADMIN_AUTH_HEADER },
      body: JSON.stringify({ action: "activate" }),
    });
    const body = await res.json();
    assert.equal(res.status, 400);
    assert.equal(body.code, "SUBSCRIPTION_EXPIRED");
    assert.notEqual(status("MERCHANT002"), "ACTIVE");
  } finally {
    server.close();
  }
});
