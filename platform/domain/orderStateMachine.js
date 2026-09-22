// Phase 6 order lifecycle. Same whitelist-transition shape as A Tiểu's
// own src/domain/orderStateMachine.js (reused as a pattern, not as code —
// A Tiểu's status set has no dispatch concept and this is a different,
// smaller domain), pure and DB-free.
//
// Approved Phase 6 state machine (no payment/delivery states — this
// platform never owns the transaction, see Phase 6 Master Spec §2):
//   CREATED -> SENT_TO_MERCHANT -> RECEIVED
//   CREATED -> CANCELLED
//   SENT_TO_MERCHANT -> CANCELLED
// RECEIVED and CANCELLED are terminal — nothing transitions out of them.
export const ORDER_STATUS = Object.freeze({
  CREATED: "CREATED",
  SENT_TO_MERCHANT: "SENT_TO_MERCHANT",
  RECEIVED: "RECEIVED",
  CANCELLED: "CANCELLED",
});

const TRANSITIONS = {
  CREATED: ["SENT_TO_MERCHANT", "CANCELLED"],
  SENT_TO_MERCHANT: ["RECEIVED", "CANCELLED"],
  RECEIVED: [],
  CANCELLED: [],
};

// A same-state "transition" (X -> X) is a harmless idempotent no-op —
// needed so a dispatch retry that reports the same outcome twice (or a
// repeat cancelOrder call) never fails loudly on a redundant request.
export function canTransition(from, to) {
  if (from === to) return true;
  return Boolean(TRANSITIONS[from]?.includes(to));
}

export function assertTransition(from, to) {
  if (!canTransition(from, to)) {
    const err = new Error(`Invalid order transition: ${from} -> ${to}`);
    err.code = "INVALID_ORDER_TRANSITION";
    err.status = 409;
    throw err;
  }
}
