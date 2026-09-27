-- Generic Merchant Order Dispatch: delivering a confirmed generic order to
-- the merchant over a notification channel configured PER MERCHANT.
--
-- merchant_dispatch_channels: where THIS merchant receives its orders. One
-- row per merchant (UNIQUE merchant_id) — a merchant's destination can
-- only ever be read for that merchant's own orders. No row (or enabled = 0)
-- means "no dispatch channel": the order is recorded and stays CREATED,
-- exactly as before this migration.
--
-- order_dispatches: one delivery record per order (UNIQUE order_id) — the
-- idempotency anchor. A record that reached SENT is never sent again;
-- PENDING/FAILED (and a SENDING attempt that never finished) may be retried.
-- The order row itself is never modified by a failed delivery.

CREATE TABLE IF NOT EXISTS merchant_dispatch_channels (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant_id   TEXT NOT NULL UNIQUE REFERENCES merchants(merchant_id),
  channel       TEXT NOT NULL CHECK (channel IN ('telegram')),
  destination   TEXT NOT NULL,
  enabled       INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS order_dispatches (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id      INTEGER NOT NULL UNIQUE REFERENCES orders(id),
  merchant_id   TEXT NOT NULL REFERENCES merchants(merchant_id),
  channel       TEXT NOT NULL,
  destination   TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'SENDING', 'SENT', 'FAILED')),
  attempts      INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT,
  sent_at       TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_order_dispatches_merchant ON order_dispatches(merchant_id);
CREATE INDEX IF NOT EXISTS idx_order_dispatches_status ON order_dispatches(status);
