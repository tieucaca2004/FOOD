// Persistence for generic merchant order dispatch (migration 012): each
// merchant's own dispatch channel, and one delivery record per order.
// Pure data access — the dispatch rules live in services/merchantDispatch.js.

// A SENDING attempt older than this never finished (process died mid-send)
// and may be claimed again.
const STALE_SENDING_SECONDS = 120;

export class MerchantDispatchRepository {
  constructor(db) {
    this.db = db;
  }

  // --- per-merchant configuration --------------------------------------------------

  getChannel(merchantId) {
    return this.db.prepare(`SELECT * FROM merchant_dispatch_channels WHERE merchant_id = ?`).get(merchantId) || null;
  }

  setChannel(merchantId, { channel, destination, enabled = true }) {
    this.db
      .prepare(
        `INSERT INTO merchant_dispatch_channels (merchant_id, channel, destination, enabled) VALUES (?, ?, ?, ?)
         ON CONFLICT(merchant_id) DO UPDATE SET
           channel = excluded.channel, destination = excluded.destination, enabled = excluded.enabled, updated_at = datetime('now')`
      )
      .run(merchantId, channel, destination, enabled ? 1 : 0);
    return this.getChannel(merchantId);
  }

  setChannelEnabled(merchantId, enabled) {
    this.db
      .prepare(`UPDATE merchant_dispatch_channels SET enabled = ?, updated_at = datetime('now') WHERE merchant_id = ?`)
      .run(enabled ? 1 : 0, merchantId);
    return this.getChannel(merchantId);
  }

  // --- per-order delivery records -----------------------------------------------------

  getByOrder(orderId) {
    return this.db.prepare(`SELECT * FROM order_dispatches WHERE order_id = ?`).get(orderId) || null;
  }

  // Creates the order's record on first sight (UNIQUE order_id is the only
  // duplicate guard) and returns it.
  ensure({ orderId, merchantId, channel, destination }) {
    this.db
      .prepare(`INSERT OR IGNORE INTO order_dispatches (order_id, merchant_id, channel, destination) VALUES (?, ?, ?, ?)`)
      .run(orderId, merchantId, channel, destination);
    return this.getByOrder(orderId);
  }

  // Atomically takes the record for one send attempt: only from PENDING,
  // FAILED or a stale SENDING. Returns true when this caller owns the attempt.
  claim(id, { channel, destination }) {
    const { changes } = this.db
      .prepare(
        `UPDATE order_dispatches
         SET status = 'SENDING', attempts = attempts + 1, channel = ?, destination = ?, updated_at = datetime('now')
         WHERE id = ? AND (status IN ('PENDING', 'FAILED')
                           OR (status = 'SENDING' AND updated_at < datetime('now', ?)))`
      )
      .run(channel, destination, id, `-${STALE_SENDING_SECONDS} seconds`);
    return changes === 1;
  }

  markSent(id) {
    this.db
      .prepare(`UPDATE order_dispatches SET status = 'SENT', last_error = NULL, sent_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`)
      .run(id);
  }

  markFailed(id, error) {
    this.db
      .prepare(`UPDATE order_dispatches SET status = 'FAILED', last_error = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(String(error ?? "unknown").slice(0, 500), id);
  }

  // Orders whose delivery can be retried: failed (under the attempt cap) or
  // stuck mid-send, and still CREATED (a cancelled or already-sent order is never retried).
  listRetryable({ maxAttempts }) {
    return this.db
      .prepare(
        `SELECT d.* FROM order_dispatches d JOIN orders o ON o.id = d.order_id
         WHERE o.status = 'CREATED' AND d.attempts < ?
           AND (d.status IN ('PENDING', 'FAILED') OR (d.status = 'SENDING' AND d.updated_at < datetime('now', ?)))
         ORDER BY d.id`
      )
      .all(maxAttempts, `-${STALE_SENDING_SECONDS} seconds`);
  }
}
