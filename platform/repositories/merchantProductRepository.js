// Catalog for "generic" (data-driven, no dedicated module) merchants only.
function parseProduct(row) {
  if (!row) return row;
  return { ...row, available: Boolean(row.available), keywords: JSON.parse(row.keywords_json || "[]") };
}

export class MerchantProductRepository {
  constructor(db) {
    this.db = db;
  }

  listByMerchant(merchantId, { includeUnavailable = false } = {}) {
    const rows = includeUnavailable
      ? this.db.prepare(`SELECT * FROM merchant_products WHERE merchant_id = ? ORDER BY sort_order, id`).all(merchantId)
      : this.db
          .prepare(`SELECT * FROM merchant_products WHERE merchant_id = ? AND available = 1 ORDER BY sort_order, id`)
          .all(merchantId);
    return rows.map(parseProduct);
  }

  findById(id) {
    return parseProduct(this.db.prepare(`SELECT * FROM merchant_products WHERE id = ?`).get(id));
  }

  create(merchantId, product) {
    const { lastInsertRowid } = this.db
      .prepare(
        `INSERT INTO merchant_products (merchant_id, sku, name, category_id, description, price, image_url, available, sort_order, keywords_json)
         VALUES (@merchant_id, @sku, @name, @category_id, @description, @price, @image_url, @available, @sort_order, @keywords_json)`
      )
      .run({
        merchant_id: merchantId,
        sku: product.sku,
        name: product.name,
        category_id: product.categoryId || null,
        description: product.description || null,
        price: product.price,
        image_url: product.imageUrl || null,
        available: product.available === false ? 0 : 1,
        sort_order: product.sortOrder || 0,
        keywords_json: JSON.stringify(product.keywords || []),
      });
    return this.findById(lastInsertRowid);
  }

  setAvailability(productId, available) {
    this.db
      .prepare(`UPDATE merchant_products SET available = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(available ? 1 : 0, productId);
    return this.findById(productId);
  }

  update(productId, patch) {
    const current = this.findById(productId);
    this.db
      .prepare(
        `UPDATE merchant_products SET
           name = ?, category_id = ?, description = ?, price = ?, image_url = ?,
           available = ?, sort_order = ?, keywords_json = ?, updated_at = datetime('now')
         WHERE id = ?`
      )
      .run(
        patch.name ?? current.name,
        patch.categoryId !== undefined ? patch.categoryId : current.category_id,
        patch.description !== undefined ? patch.description : current.description,
        patch.price ?? current.price,
        patch.imageUrl !== undefined ? patch.imageUrl : current.image_url,
        patch.available !== undefined ? (patch.available ? 1 : 0) : current.available ? 1 : 0,
        patch.sortOrder ?? current.sort_order,
        patch.keywords !== undefined ? JSON.stringify(patch.keywords) : JSON.stringify(current.keywords),
        productId
      );
    return this.findById(productId);
  }
}
