// Merchant Dispatch boundary (Phase 6). There is currently no real
// merchant push channel and no merchant authentication anywhere in the
// platform (audited — see Phase 6 Master Spec §1/§8): no per-merchant
// webhook URL, no merchant-side Zalo OA token, no merchant login. This
// interface exists so OrderService has something concrete to call
// without ever fabricating a "the merchant received this" result.
//
// Same shape as PaymentProvider/DeliveryProvider (abstract class + a
// NullXProvider that never claims success) — reused as a pattern, not as
// code, since this is a distinct domain (dispatch, not money/delivery).
export class MerchantDispatchPort {
  /** @returns {Promise<{delivered: boolean, reason?: string}>} */
  async dispatch(_order) {
    throw new Error("MerchantDispatchPort.dispatch not implemented");
  }
}

// Never claims delivery. An order dispatched through this port stays at
// CREATED — OrderService only advances to SENT_TO_MERCHANT when
// dispatch() actually reports delivered:true (approved decision D — "no
// fake success").
export class NullMerchantDispatchPort extends MerchantDispatchPort {
  async dispatch(_order) {
    return { delivered: false, reason: "NO_DISPATCH_CHANNEL" };
  }
}
