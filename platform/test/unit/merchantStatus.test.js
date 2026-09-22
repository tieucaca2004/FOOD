import { test } from "node:test";
import assert from "node:assert/strict";
import { isDiscoverable, MERCHANT_STATUS } from "../../domain/merchantStatus.js";

test("only ACTIVE and TRIAL are discoverable", () => {
  assert.equal(isDiscoverable(MERCHANT_STATUS.ACTIVE), true);
  assert.equal(isDiscoverable(MERCHANT_STATUS.TRIAL), true);
  assert.equal(isDiscoverable(MERCHANT_STATUS.PENDING), false);
  assert.equal(isDiscoverable(MERCHANT_STATUS.SUSPENDED), false);
  assert.equal(isDiscoverable(MERCHANT_STATUS.EXPIRED), false);
  assert.equal(isDiscoverable(MERCHANT_STATUS.CLOSED), false);
});
