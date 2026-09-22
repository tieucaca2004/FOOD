// Phase 6.x: cart lifecycle values written by the Order Engine into the
// PRE-EXISTING, unconstrained merchant_carts.status TEXT column (migration
// 005, frozen — no schema change here, only a previously-unused value
// written into an already-generic column that Phase 5's own comment
// anticipated: "ACTIVE only in Phase 5 (no checkout/order yet)").
//
// This works with ZERO changes to any frozen Phase 1-5 file, verified by
// audit + a live empirical check before implementation:
//   - CartService._ownedCart() (frozen, unmodified) already rejects any
//     further read/mutation on a cart whose status isn't exactly
//     'ACTIVE' — throws CART_INACTIVE.
//   - CartRepository.getActiveByCustomerAndMerchant() (frozen,
//     unmodified) already filters `WHERE status = 'ACTIVE'`, so a
//     CONVERTED cart is invisible to it.
//   - migration 005's partial UNIQUE index on merchant_carts(customer_id,
//     merchant_id) is already scoped `WHERE status = 'ACTIVE'`, so it
//     never blocks a brand-new ACTIVE cart once the old one is CONVERTED.
// A converted cart's row is never deleted — it stays as the historical
// record `orders.cart_id` points back to.
export const CART_LIFECYCLE_STATUS = Object.freeze({
  ACTIVE: "ACTIVE",
  CONVERTED: "CONVERTED",
});
