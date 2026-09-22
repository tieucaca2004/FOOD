export class MerchantSubscriptionRepository {
  constructor(db) {
    this.db = db;
  }

  getPlan(planId) {
    return this.db.prepare(`SELECT * FROM plans WHERE plan_id = ?`).get(planId);
  }

  getActiveByMerchant(merchantId) {
    return this.db
      .prepare(`SELECT * FROM merchant_subscriptions WHERE merchant_id = ? ORDER BY id DESC LIMIT 1`)
      .get(merchantId);
  }

  startTrial(merchantId, planId, startedAt, trialEndsAt) {
    const { lastInsertRowid } = this.db
      .prepare(
        `INSERT INTO merchant_subscriptions (merchant_id, plan_id, status, trial_started_at, trial_ends_at)
         VALUES (?, ?, 'TRIAL', ?, ?)`
      )
      .run(merchantId, planId, startedAt, trialEndsAt);
    return this.db.prepare(`SELECT * FROM merchant_subscriptions WHERE id = ?`).get(lastInsertRowid);
  }

  setStatus(subscriptionId, status) {
    this.db
      .prepare(`UPDATE merchant_subscriptions SET status = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(status, subscriptionId);
    return this.db.prepare(`SELECT * FROM merchant_subscriptions WHERE id = ?`).get(subscriptionId);
  }

  setExpiresAt(subscriptionId, expiresAt) {
    this.db
      .prepare(`UPDATE merchant_subscriptions SET expires_at = ?, started_at = COALESCE(started_at, datetime('now')), updated_at = datetime('now') WHERE id = ?`)
      .run(expiresAt, subscriptionId);
    return this.db.prepare(`SELECT * FROM merchant_subscriptions WHERE id = ?`).get(subscriptionId);
  }
}
