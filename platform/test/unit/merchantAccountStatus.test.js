import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ACCOUNT_STATUS,
  SUBSCRIPTION_STATUS,
  deriveAccountFieldsFromLegacyStatus,
  isAccountDiscoverable,
} from "../../domain/merchantStatus.js";

test("legacy status maps to the correct split account_status/active pair", () => {
  assert.deepEqual(deriveAccountFieldsFromLegacyStatus("PENDING"), { accountStatus: ACCOUNT_STATUS.PENDING, active: false });
  assert.deepEqual(deriveAccountFieldsFromLegacyStatus("TRIAL"), { accountStatus: ACCOUNT_STATUS.ACTIVE, active: true });
  assert.deepEqual(deriveAccountFieldsFromLegacyStatus("ACTIVE"), { accountStatus: ACCOUNT_STATUS.ACTIVE, active: true });
  assert.deepEqual(deriveAccountFieldsFromLegacyStatus("SUSPENDED"), {
    accountStatus: ACCOUNT_STATUS.TEMPORARY_SUSPENDED,
    active: false,
  });
  assert.deepEqual(deriveAccountFieldsFromLegacyStatus("EXPIRED"), { accountStatus: ACCOUNT_STATUS.EXPIRED, active: false });
  assert.deepEqual(deriveAccountFieldsFromLegacyStatus("CLOSED"), { accountStatus: ACCOUNT_STATUS.CLOSED, active: false });
});

test("unknown legacy status defaults to the safe (non-discoverable) PENDING mapping", () => {
  assert.deepEqual(deriveAccountFieldsFromLegacyStatus("something-unexpected"), {
    accountStatus: ACCOUNT_STATUS.PENDING,
    active: false,
  });
});

test("isAccountDiscoverable requires BOTH account_status ACTIVE and active=true", () => {
  assert.equal(isAccountDiscoverable({ accountStatus: ACCOUNT_STATUS.ACTIVE, active: true }), true);
  assert.equal(isAccountDiscoverable({ accountStatus: ACCOUNT_STATUS.ACTIVE, active: false }), false);
  assert.equal(isAccountDiscoverable({ accountStatus: ACCOUNT_STATUS.TEMPORARY_SUSPENDED, active: true }), false);
  assert.equal(isAccountDiscoverable({ accountStatus: ACCOUNT_STATUS.PENDING, active: false }), false);
});

test("subscription_status enum matches spec (TRIAL/ACTIVE/EXPIRED/CANCELLED)", () => {
  assert.deepEqual(Object.values(SUBSCRIPTION_STATUS).sort(), ["ACTIVE", "CANCELLED", "EXPIRED", "TRIAL"]);
});

test("account_status enum matches spec (PENDING/ACTIVE/TEMPORARY_SUSPENDED/EXPIRED/CLOSED — no TRIAL)", () => {
  assert.deepEqual(Object.values(ACCOUNT_STATUS).sort(), ["ACTIVE", "CLOSED", "EXPIRED", "PENDING", "TEMPORARY_SUSPENDED"]);
});
