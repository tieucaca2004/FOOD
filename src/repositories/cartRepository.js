export class CartRepository {
  constructor(db) {
    this.db = db;
  }

  getActiveByCustomer(customerId) {
    return this.db
      .prepare(`SELECT * FROM carts WHERE customer_id = ? AND status = 'active'`)
      .get(customerId);
  }

  createActive(customerId) {
    const { lastInsertRowid } = this.db
      .prepare(`INSERT INTO carts (customer_id, status) VALUES (?, 'active')`)
      .run(customerId);
    return this.getById(lastInsertRowid);
  }

  getOrCreateActive(customerId) {
    return this.getActiveByCustomer(customerId) || this.createActive(customerId);
  }

  getById(id) {
    return this.db.prepare(`SELECT * FROM carts WHERE id = ?`).get(id);
  }

  setStatus(id, status) {
    this.db.prepare(`UPDATE carts SET status = ?, updated_at = datetime('now') WHERE id = ?`).run(status, id);
  }

  listItems(cartId) {
    return this.db
      .prepare(
        `SELECT ci.*, p.name AS product_name, p.available AS product_available
         FROM cart_items ci
         JOIN products p ON p.id = ci.product_id
         WHERE ci.cart_id = ?
         ORDER BY ci.id`
      )
      .all(cartId)
      .map((r) => ({ ...r, product_available: Boolean(r.product_available) }));
  }

  findItemByProduct(cartId, productId) {
    return this.db
      .prepare(`SELECT * FROM cart_items WHERE cart_id = ? AND product_id = ?`)
      .get(cartId, productId);
  }

  findItemById(itemId) {
    return this.db.prepare(`SELECT * FROM cart_items WHERE id = ?`).get(itemId);
  }

  addItem(cartId, productId, quantity, unitPrice) {
    const { lastInsertRowid } = this.db
      .prepare(`INSERT INTO cart_items (cart_id, product_id, quantity, unit_price) VALUES (?, ?, ?, ?)`)
      .run(cartId, productId, quantity, unitPrice);
    this.db.prepare(`UPDATE carts SET updated_at = datetime('now') WHERE id = ?`).run(cartId);
    return this.findItemById(lastInsertRowid);
  }

  setItemQuantity(itemId, quantity) {
    this.db
      .prepare(`UPDATE cart_items SET quantity = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(quantity, itemId);
  }

  removeItem(itemId) {
    this.db.prepare(`DELETE FROM cart_items WHERE id = ?`).run(itemId);
  }

  clearItems(cartId) {
    this.db.prepare(`DELETE FROM cart_items WHERE cart_id = ?`).run(cartId);
  }
}
