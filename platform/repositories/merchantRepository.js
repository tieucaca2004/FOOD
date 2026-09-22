import { isDiscoverable, deriveAccountFieldsFromLegacyStatus } from "../domain/merchantStatus.js";

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
    const status = merchant.status || "PENDING";
    const { accountStatus, active } = deriveAccountFieldsFromLegacyStatus(status);
    this.db
      .prepare(
        `INSERT INTO merchants (merchant_id, name, slug, module, status, account_status, active, description, address, phone)
         VALUES (@merchant_id, @name, @slug, @module, @status, @account_status, @active, @description, @address, @phone)`
      )
      .run({
        merchant_id: merchant.merchantId,
        name: merchant.name,
        slug: merchant.slug,
        module: merchant.module,
        status,
        account_status: accountStatus,
        active: active ? 1 : 0,
        description: merchant.description || null,
        address: merchant.address || null,
        phone: merchant.phone || null,
      });
    return this.getById(merchant.merchantId);
  }

  // Legacy single-enum write path — kept for backward compatibility with
  // existing callers/tests. Dual-writes the new split account_status/active
  // fields (see domain/merchantStatus.js) so both models always agree;
  // callers that have migrated to the new model should prefer
  // setAccountStatus() below instead.
  setStatus(merchantId, status) {
    const { accountStatus, active } = deriveAccountFieldsFromLegacyStatus(status);
    this.db
      .prepare(
        `UPDATE merchants SET status = ?, account_status = ?, active = ?, updated_at = datetime('now') WHERE merchant_id = ?`
      )
      .run(status, accountStatus, active ? 1 : 0, merchantId);
    return this.getById(merchantId);
  }

  // New, spec-aligned write path: sets account_status/active directly
  // without going through the legacy status mapping. Does not touch the
  // legacy `status` column — callers relying on that column for other
  // purposes should migrate deliberately, not silently via this method.
  setAccountStatus(merchantId, accountStatus, active) {
    this.db
      .prepare(`UPDATE merchants SET account_status = ?, active = ?, updated_at = datetime('now') WHERE merchant_id = ?`)
      .run(accountStatus, active ? 1 : 0, merchantId);
    return this.getById(merchantId);
  }
}
