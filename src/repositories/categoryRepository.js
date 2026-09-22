export class CategoryRepository {
  constructor(db) {
    this.db = db;
  }

  list() {
    return this.db.prepare(`SELECT * FROM categories ORDER BY sort_order, id`).all();
  }
}
