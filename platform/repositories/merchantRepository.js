import { isDiscoverable } from "../domain/merchantStatus.js";

export class MerchantRepository {
  constructor(db) {
    this.db = db;
  }

  getById(merchantId) {
    return this.db.prepare(`SELECT * FROM merchants WHERE merchant_id = ?`).get(merchantId);
  }

  getBySlug(slug) {
    return this.db.prepare(`SELECT * FROM merchants WHERE slug = ?`).get(slug);
  }

  listAll() {
    return this.db.prepare(`SELECT * FROM merchants ORDER BY created_at`).all();
  }

  // Only merchants Discovery is allowed to surface at all (status-wise —
  // availability/open-now is a separate, later filter).
  listDiscoverable() {
    return this.listAll().filter((m) => isDiscoverable(m.status));
  }

  findByNameFragment(text) {
    const normalized = `%${text.trim()}%`;
    return this.db.prepare(`SELECT * FROM merchants WHERE name LIKE ? COLLATE NOCASE`).all(normalized);
  }

  create(merchant) {
    this.db
      .prepare(
        `INSERT INTO merchants (merchant_id, name, slug, module, status, description, address, phone)
         VALUES (@merchant_id, @name, @slug, @module, @status, @description, @address, @phone)`
      )
      .run({
        merchant_id: merchant.merchantId,
        name: merchant.name,
        slug: merchant.slug,
        module: merchant.module,
        status: merchant.status || "PENDING",
        description: merchant.description || null,
        address: merchant.address || null,
        phone: merchant.phone || null,
      });
    return this.getById(merchant.merchantId);
  }

  setStatus(merchantId, status) {
    this.db
      .prepare(`UPDATE merchants SET status = ?, updated_at = datetime('now') WHERE merchant_id = ?`)
      .run(status, merchantId);
    return this.getById(merchantId);
  }
}
