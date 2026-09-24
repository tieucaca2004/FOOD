import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTestPlatform } from "../helpers/testPlatform.js";

// Forces the check-then-insert window: both callers see "no customer yet".
function withStaleLookup(platform, fn) {
  const repo = platform.repos.customers;
  const original = repo.findByZaloUserId.bind(repo);
  let staleReads = 2;
  repo.findByZaloUserId = (id) => (staleReads-- > 0 ? undefined : original(id));
  try {
    return fn();
  } finally {
    repo.findByZaloUserId = original;
  }
}

function customerRows(platform, zaloUserId) {
  return platform.db.prepare("SELECT id FROM platform_customers WHERE zalo_user_id = ?").all(zaloUserId);
}

test("BUG-004: two racing creations of the same identity converge on one customer, and both callers get it", () => {
  const platform = buildTestPlatform({ withAtieu: false });
  const identity = "telegram:5550001";

  const [first, second] = withStaleLookup(platform, () => [
    platform.services.customers.getOrCreateByZaloUserId(identity, "Khách"),
    platform.services.customers.getOrCreateByZaloUserId(identity, "Khách"),
  ]);

  assert.equal(customerRows(platform, identity).length, 1);
  assert.ok(first?.id);
  assert.equal(second.id, first.id);
  assert.equal(second.zalo_user_id, identity);
});

test("BUG-004: channel namespacing is preserved — the same raw id on Zalo and Telegram stays two customers", () => {
  const platform = buildTestPlatform({ withAtieu: false });
  const zalo = platform.services.customers.getOrCreateByZaloUserId("5550002", null);
  const telegram = withStaleLookup(platform, () => platform.services.customers.getOrCreateByZaloUserId("telegram:5550002", null));
  assert.notEqual(zalo.id, telegram.id);
  assert.equal(customerRows(platform, "telegram:5550002").length, 1);
});

test("BUG-004: unrelated database errors on create are still raised", () => {
  const platform = buildTestPlatform({ withAtieu: false });
  platform.repos.customers.create = () => {
    throw new Error("SQLITE_BUSY: database is locked");
  };
  assert.throws(() => platform.services.customers.getOrCreateByZaloUserId("telegram:5550003", null), /SQLITE_BUSY/);
});
