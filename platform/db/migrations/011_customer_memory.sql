-- Customer Memory V1 — additive only. Structured, evidence-based memory
-- per platform customer. Orders stay the source of truth: nothing here
-- copies items, quantities or prices.

-- Food/order preferences the customer stated, or showed repeatedly.
--   scope: global | merchant | product (merchant_id / product_id set accordingly)
--   attribute: onion | pepper | chili | sauce | ... ; value: avoid | low | extra | normal
--   status: CANDIDATE (order evidence only, not applied) | ACTIVE (applied) | RETIRED
CREATE TABLE IF NOT EXISTS customer_preferences (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id          INTEGER NOT NULL REFERENCES platform_customers(id),
  merchant_id          TEXT REFERENCES merchants(merchant_id),
  product_id           INTEGER,
  scope                TEXT NOT NULL CHECK (scope IN ('global', 'merchant', 'product')),
  preference_type      TEXT NOT NULL DEFAULT 'ingredient',
  attribute            TEXT NOT NULL,
  value                TEXT NOT NULL CHECK (value IN ('avoid', 'low', 'extra', 'normal')),
  label                TEXT NOT NULL,
  confidence           REAL NOT NULL,
  evidence_count       INTEGER NOT NULL DEFAULT 1,
  contradiction_count  INTEGER NOT NULL DEFAULT 0,
  source               TEXT NOT NULL,  -- explicit_customer_statement | customer_correction | confirmed_order
  status               TEXT NOT NULL CHECK (status IN ('CANDIDATE', 'ACTIVE', 'RETIRED')),
  first_seen_at        TEXT NOT NULL DEFAULT (datetime('now')),
  last_confirmed_at    TEXT NOT NULL DEFAULT (datetime('now')),
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
);
-- one row per (customer, scope target, attribute); NULL-safe
CREATE UNIQUE INDEX IF NOT EXISTS idx_customer_preferences_key
  ON customer_preferences(customer_id, scope, IFNULL(merchant_id, ''), IFNULL(product_id, 0), attribute);

-- Addresses the customer has used or named. The current order's address
-- still lives in its checkout (cart_checkout / the module's own order).
CREATE TABLE IF NOT EXISTS customer_addresses (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id         INTEGER NOT NULL REFERENCES platform_customers(id),
  label               TEXT,            -- e.g. "nhà", "công ty"; NULL = unlabeled
  address             TEXT NOT NULL,
  normalized_address  TEXT NOT NULL,
  is_default          INTEGER NOT NULL DEFAULT 0,
  usage_count         INTEGER NOT NULL DEFAULT 0,
  last_used_at        TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (customer_id, normalized_address)
);

-- References to the customer's confirmed orders (generic orders or a
-- module's own orders), with the structured food instructions that order
-- was placed with — the one thing no order record holds. Items, quantities,
-- prices and address are always read from the real order.
CREATE TABLE IF NOT EXISTS customer_order_refs (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id        INTEGER NOT NULL REFERENCES platform_customers(id),
  merchant_id        TEXT NOT NULL REFERENCES merchants(merchant_id),
  order_ref          TEXT NOT NULL,   -- the order's own code (TD-… / AT-…)
  instructions_json  TEXT NOT NULL DEFAULT '[]',
  ordered_at         TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (merchant_id, order_ref)
);
CREATE INDEX IF NOT EXISTS idx_customer_order_refs_lookup ON customer_order_refs(customer_id, merchant_id, ordered_at);
