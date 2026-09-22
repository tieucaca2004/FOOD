import { test } from "node:test";
import assert from "node:assert/strict";
import { canTransition, assertTransition, ORDER_STATUS } from "../../src/domain/orderStateMachine.js";

test("happy path transitions are all allowed in sequence", () => {
  const sequence = [
    ORDER_STATUS.DRAFT,
    ORDER_STATUS.PENDING_CONFIRMATION,
    ORDER_STATUS.CONFIRMED,
    ORDER_STATUS.ACCEPTED,
    ORDER_STATUS.PREPARING,
    ORDER_STATUS.READY,
    ORDER_STATUS.COMPLETED,
  ];
  for (let i = 0; i < sequence.length - 1; i++) {
    assert.equal(canTransition(sequence[i], sequence[i + 1]), true);
  }
});

test("cancellation is allowed from active states but not from terminal ones", () => {
  assert.equal(canTransition(ORDER_STATUS.DRAFT, ORDER_STATUS.CANCELLED), true);
  assert.equal(canTransition(ORDER_STATUS.CONFIRMED, ORDER_STATUS.CANCELLED), true);
  assert.equal(canTransition(ORDER_STATUS.PREPARING, ORDER_STATUS.CANCELLED), true);
  assert.equal(canTransition(ORDER_STATUS.READY, ORDER_STATUS.CANCELLED), false);
  assert.equal(canTransition(ORDER_STATUS.COMPLETED, ORDER_STATUS.CANCELLED), false);
});

test("cannot skip states arbitrarily", () => {
  assert.equal(canTransition(ORDER_STATUS.DRAFT, ORDER_STATUS.CONFIRMED), false);
  assert.equal(canTransition(ORDER_STATUS.DRAFT, ORDER_STATUS.COMPLETED), false);
});

test("assertTransition throws a 409-tagged error on an invalid move", () => {
  assert.throws(() => assertTransition(ORDER_STATUS.DRAFT, ORDER_STATUS.COMPLETED), (err) => {
    assert.equal(err.code, "INVALID_TRANSITION");
    assert.equal(err.status, 409);
    return true;
  });
});
