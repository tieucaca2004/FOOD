import { test } from "node:test";
import assert from "node:assert/strict";
import { ORDER_STATUS, canTransition, assertTransition } from "../../domain/orderStateMachine.js";

test("allowed transitions: CREATED -> SENT_TO_MERCHANT", () => {
  assert.equal(canTransition(ORDER_STATUS.CREATED, ORDER_STATUS.SENT_TO_MERCHANT), true);
});

test("allowed transitions: CREATED -> CANCELLED", () => {
  assert.equal(canTransition(ORDER_STATUS.CREATED, ORDER_STATUS.CANCELLED), true);
});

test("allowed transitions: SENT_TO_MERCHANT -> RECEIVED", () => {
  assert.equal(canTransition(ORDER_STATUS.SENT_TO_MERCHANT, ORDER_STATUS.RECEIVED), true);
});

test("allowed transitions: SENT_TO_MERCHANT -> CANCELLED", () => {
  assert.equal(canTransition(ORDER_STATUS.SENT_TO_MERCHANT, ORDER_STATUS.CANCELLED), true);
});

test("forbidden: CREATED -> RECEIVED (cannot skip SENT_TO_MERCHANT)", () => {
  assert.equal(canTransition(ORDER_STATUS.CREATED, ORDER_STATUS.RECEIVED), false);
});

test("forbidden: RECEIVED is terminal — nothing transitions out of it", () => {
  for (const to of Object.values(ORDER_STATUS)) {
    if (to === ORDER_STATUS.RECEIVED) continue;
    assert.equal(canTransition(ORDER_STATUS.RECEIVED, to), false, `RECEIVED -> ${to}`);
  }
});

test("forbidden: CANCELLED is terminal — nothing transitions out of it", () => {
  for (const to of Object.values(ORDER_STATUS)) {
    if (to === ORDER_STATUS.CANCELLED) continue;
    assert.equal(canTransition(ORDER_STATUS.CANCELLED, to), false, `CANCELLED -> ${to}`);
  }
});

test("forbidden: DELIVERED-shaped regressions are impossible since DELIVERED does not exist — explicit forbidden pairs from terminal states", () => {
  assert.equal(canTransition(ORDER_STATUS.RECEIVED, ORDER_STATUS.SENT_TO_MERCHANT), false);
  assert.equal(canTransition(ORDER_STATUS.CANCELLED, ORDER_STATUS.SENT_TO_MERCHANT), false);
  assert.equal(canTransition(ORDER_STATUS.CANCELLED, ORDER_STATUS.CREATED), false);
});

test("same-state transition is a harmless idempotent no-op for every state", () => {
  for (const s of Object.values(ORDER_STATUS)) {
    assert.equal(canTransition(s, s), true, `${s} -> ${s}`);
  }
});

test("assertTransition throws INVALID_ORDER_TRANSITION for a forbidden pair", () => {
  assert.throws(() => assertTransition(ORDER_STATUS.CREATED, ORDER_STATUS.RECEIVED), (err) => {
    assert.equal(err.code, "INVALID_ORDER_TRANSITION");
    assert.equal(err.status, 409);
    return true;
  });
});

test("assertTransition does not throw for an allowed pair", () => {
  assert.doesNotThrow(() => assertTransition(ORDER_STATUS.CREATED, ORDER_STATUS.CANCELLED));
});
