export class PromotionRepository {
  constructor(db) {
    this.db = db;
  }

  listActive() {
    return this.db
      .prepare(
        `SELECT * FROM promotions
         WHERE active = 1
           AND (starts_at IS NULL OR starts_at <= datetime('now'))
           AND (ends_at IS NULL OR ends_at >= datetime('now'))`
      )
      .all();
  }
}
