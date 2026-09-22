import { logger } from "../../src/logger.js";
import { deriveAccountFieldsFromLegacyStatus } from "../domain/merchantStatus.js";

// Idempotent, production-safe seed: registers ONLY the real, already-live
// A Tiểu merchant. Never inserts placeholder/demo merchants into the real
// platform DB — a second merchant for testing multi-merchant discovery
// lives only in test fixtures (test/platform/helpers.js), never here.
export function runPlatformSeed(db) {
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_plans_name ON plans(plan_id)`);

  const upsertPlan = db.prepare(`
    INSERT INTO plans (plan_id, name, price, trial_days, active)
    VALUES (@plan_id, @name, @price, @trial_days, 1)
    ON CONFLICT(plan_id) DO UPDATE SET name = excluded.name, price = excluded.price, trial_days = excluded.trial_days
  `);
  upsertPlan.run({ plan_id: "free", name: "Free", price: 0, trial_days: null });

  const { accountStatus, active } = deriveAccountFieldsFromLegacyStatus("ACTIVE");
  const upsertMerchant = db.prepare(`
    INSERT INTO merchants (merchant_id, name, slug, module, status, account_status, active, description, address)
    VALUES (@merchant_id, @name, @slug, @module, @status, @account_status, @active, @description, @address)
    ON CONFLICT(merchant_id) DO UPDATE SET
      name = excluded.name,
      slug = excluded.slug,
      module = excluded.module,
      account_status = excluded.account_status,
      active = excluded.active,
      updated_at = datetime('now')
  `);
  upsertMerchant.run({
    merchant_id: "ATIEU001",
    name: "Hủ Tiếu Xào A Tiểu",
    slug: "hu-tieu-xao-a-tieu",
    module: "atieu",
    status: "ACTIVE",
    account_status: accountStatus,
    active: active ? 1 : 0,
    description: "Hủ tiếu xào — quán ăn đã vận hành qua module đặt món riêng.",
    address: null, // real address still pending owner confirmation — see src/../data/seed/NEEDS_OWNER_INPUT.md
  });

  const existingSub = db.prepare(`SELECT id FROM merchant_subscriptions WHERE merchant_id = ?`).get("ATIEU001");
  if (!existingSub) {
    db.prepare(
      `INSERT INTO merchant_subscriptions (merchant_id, plan_id, status, started_at)
       VALUES ('ATIEU001', 'free', 'ACTIVE', datetime('now'))`
    ).run();
  }

  logger.info("DB", "platform seed applied", { merchants: 1 });
}
