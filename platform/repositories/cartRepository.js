export class CartRepository {
  constructor(db) {
    this.db = db;
  }

  getById(cartId) {
    return this.db.prepare(`SELECT * FROM merchant_carts WHERE id = ?`).get(cartId);
  }

  getActiveByCustomerAndMerchant(customerId, merchantId) {
    return this.db
      .prepare(`SELECT * FROM merchant_carts WHERE customer_id = ? AND merchant_id = ? AND status = 'ACTIVE'`)
      .get(customerId, merchantId);
  }

  create(customerId, merchantId) {
    const { lastInsertRowid } = this.db
      .prepare(`INSERT INTO merchant_carts (merchant_id, customer_id, status) VALUES (?, ?, 'ACTIVE')`)
      .run(merchantId, customerId);
    return this.getById(lastInsertRowid);
  }

  touch(cartId) {
    this.db.prepare(`UPDATE merchant_carts SET updated_at = datetime('now') WHERE id = ?`).run(cartId);
  }

  listItems(cartId) {
    return this.db.prepare(`SELECT * FROM merchant_cart_items WHERE cart_id = ? ORDER BY id`).all(cartId);
  }

  findItemById(itemId) {
    return this.db.prepare(`SELECT * FROM merchant_cart_items WHERE id = ?`).get(itemId);
  }

  findItemByProduct(cartId, productId) {
    return this.db.prepare(`SELECT * FROM merchant_cart_items WHERE cart_id = ? AND product_id = ?`).get(cartId, productId);
  }

  addItem(cartId, merchantId, productId, productName, unitPrice, quantity) {
    const { lastInsertRowid } = this.db
      .prepare(
        `INSERT INTO merchant_cart_items (cart_id, merchant_id, product_id, product_name, unit_price, quantity)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(cartId, merchantId, productId, productName, unitPrice, quantity);
    this.touch(cartId);
    return this.findItemById(lastInsertRowid);
  }

  setItemQuantity(itemId, quantity) {
    this.db.prepare(`UPDATE merchant_cart_items SET quantity = ?, updated_at = datetime('now') WHERE id = ?`).run(quantity, itemId);
  }

  removeItem(itemId) {
    this.db.prepare(`DELETE FROM merchant_cart_items WHERE id = ?`).run(itemId);
  }

  clearItems(cartId) {
    this.db.prepare(`DELETE FROM merchant_cart_items WHERE cart_id = ?`).run(cartId);
  }
}
