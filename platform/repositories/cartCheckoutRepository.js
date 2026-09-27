// Checkout details for a cart (migration 009). The order created from the
// cart reaches them through orders.cart_id.
export class CartCheckoutRepository {
  constructor(db) {
    this.db = db;
  }

  getByCart(cartId) {
    return this.db.prepare(`SELECT * FROM cart_checkout WHERE cart_id = ?`).get(cartId) || null;
  }

  // Only the fields present in `patch` change; undefined leaves a field as is.
  upsert(cartId, patch) {
    const current = this.getByCart(cartId) || {};
    const pick = (key) => (patch[key] === undefined ? current[key] ?? null : patch[key]);
    this.db
      .prepare(
        `INSERT INTO cart_checkout (cart_id, fulfillment_type, delivery_address, customer_phone, note, updated_at)
         VALUES (@cart_id, @fulfillment_type, @delivery_address, @customer_phone, @note, datetime('now'))
         ON CONFLICT(cart_id) DO UPDATE SET
           fulfillment_type = excluded.fulfillment_type,
           delivery_address = excluded.delivery_address,
           customer_phone = excluded.customer_phone,
           note = excluded.note,
           updated_at = datetime('now')`
      )
      .run({
        cart_id: cartId,
        fulfillment_type: pick("fulfillment_type"),
        delivery_address: pick("delivery_address"),
        customer_phone: pick("customer_phone"),
        note: pick("note"),
      });
    return this.getByCart(cartId);
  }
}
