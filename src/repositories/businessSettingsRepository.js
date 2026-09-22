export class BusinessSettingsRepository {
  constructor(db) {
    this.db = db;
  }

  get(key) {
    return this.db.prepare(`SELECT value FROM business_settings WHERE key = ?`).get(key)?.value ?? null;
  }

  getAll() {
    const rows = this.db.prepare(`SELECT key, value FROM business_settings`).all();
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }
}
