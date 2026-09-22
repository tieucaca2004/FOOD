import { MerchantDispatchPort } from "../../services/merchantDispatch.js";

// Deterministic test double — configure per-test via `result` (a fixed
// dispatch outcome to return) or `failWith` (an Error to throw). Records
// every call for assertions on how many times/with what order dispatch()
// was invoked.
export class FakeMerchantDispatchPort extends MerchantDispatchPort {
  constructor({ result, failWith } = {}) {
    super();
    this.result = result;
    this.failWith = failWith;
    this.calls = [];
  }

  async dispatch(order) {
    this.calls.push(order);
    if (this.failWith) throw this.failWith;
    return this.result ?? { delivered: false, reason: "NO_DISPATCH_CHANNEL" };
  }
}
