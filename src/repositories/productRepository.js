function parseProduct(row) {
  if (!row) return row;
  return { ...row, available: Boolean(row.available), keywords: JSON.parse(row.keywords_json || "[]") };
}

export class ProductRepository {
  constructor(db) {
    this.db = db;
  }

  list({ includeUnavailable = false } = {}) {
    const rows = includeUnavailable
      ? this.db.prepare(`SELECT * FROM products ORDER BY sort_order, id`).all()
      : this.db.prepare(`SELECT * FROM products WHERE available = 1 ORDER BY sort_order, id`).all();
    return rows.map(parseProduct);
  }

  findById(id) {
    return parseProduct(this.db.prepare(`SELECT * FROM products WHERE id = ?`).get(id));
  }

  findBySku(sku) {
    return parseProduct(this.db.prepare(`SELECT * FROM products WHERE sku = ?`).get(sku));
  }

  listByCategoryName(categoryName) {
    const rows = this.db
      .prepare(
        `SELECT p.* FROM products p
         JOIN categories c ON c.id = p.category_id
         WHERE p.available = 1 AND c.name = ?
         ORDER BY p.sort_order, p.id`
      )
      .all(categoryName);
    return rows.map(parseProduct);
  }
}
