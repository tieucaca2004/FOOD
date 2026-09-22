-- Phase 6: Generic Order + Merchant Dispatch Engine.
--
-- orders.cart_id links a confirmed order back to the cart it was created
-- from, and is the anchor for the "at most one non-CANCELLED order per
-- cart" invariant (approved Phase 6 decision #2: a DB-level partial
-- UNIQUE index is the sole idempotency/concurrency guard — no
-- confirmation_request_id, no order_confirmations table. The DB is the
-- final concurrency authority: two concurrent confirmOrder calls on the
-- same cart race to the INSERT below, and only one can win).
--
-- SQLite has no ALTER TABLE ... ADD CONSTRAINT, so adding cart_id (NOT
-- NULL + FK) and a CHECK(status) to the existing orders table means the
-- same rebuild dance already used in migration 006: rename -> recreate
-- with the new column/constraint -> copy rows -> drop the old table ->
-- recreate indexes (dropped along with the old table).
--
-- order_items MUST be rebuilt too, even though its own column shape does
-- not change: SQLite's ALTER TABLE RENAME automatically rewrites foreign
-- keys in OTHER tables that reference the renamed one, so the moment
-- `orders` is renamed to orders_pre007 below, order_items.order_id's
-- REFERENCES orders(id) is silently rewritten by SQLite to
-- REFERENCES orders_pre007(id) — a dangling reference once orders_pre007
-- is dropped. Rebuilding order_items with an explicit REFERENCES
-- orders(id) against the NEW table fixes this back (verified against a
-- live PRAGMA foreign_key_list check during this migration's development).
--
-- This table has never been written to by any production code path in
-- any real deployment (confirmed by audit: PlatformOrderRepository was
-- wired but never called before Phase 6) — the copies below are written
-- correctly for populated tables regardless: they fail loudly on a NOT
-- NULL violation rather than silently guessing data this migration
-- cannot safely reconstruct.
--
-- Status values (Phase 6 state machine — platform/domain/orderStateMachine.js):
--   CREATED | SENT_TO_MERCHANT | RECEIVED | CANCELLED
-- payment_status/delivery_status/delivery_fee/discount columns are left
-- untouched, unused scaffolding (approved decision J) — OrderService
-- never reads or writes them.

ALTER TABLE orders RENAME TO orders_pre007;

CREATE TABLE orders (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  order_code        TEXT NOT NULL UNIQUE,
  merchant_id       TEXT NOT NULL REFERENCES merchants(merchant_id),
  customer_id       INTEGER NOT NULL REFERENCES platform_customers(id),
  cart_id           INTEGER NOT NULL REFERENCES merchant_carts(id),
  status            TEXT NOT NULL DEFAULT 'CREATED'
                      CHECK (status IN ('CREATED', 'SENT_TO_MERCHANT', 'RECEIVED', 'CANCELLED')),
  subtotal          INTEGER NOT NULL DEFAULT 0,
  delivery_fee      INTEGER NOT NULL DEFAULT 0,
  discount          INTEGER NOT NULL DEFAULT 0,
  total             INTEGER NOT NULL DEFAULT 0,
  payment_status    TEXT NOT NULL DEFAULT 'PENDING',
  delivery_status   TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO orders (id, order_code, merchant_id, customer_id, cart_id, status, subtotal, delivery_fee, discount, total, payment_status, delivery_status, created_at, updated_at)
  SELECT id, order_code, merchant_id, customer_id, NULL, status, subtotal, delivery_fee, discount, total, payment_status, delivery_status, created_at, updated_at
  FROM orders_pre007;

-- Rebuild order_items so its order_id FK points at the NEW orders table
-- (see explanation above) before orders_pre007 is dropped.
ALTER TABLE order_items RENAME TO order_items_pre007;

CREATE TABLE order_items (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id      INTEGER NOT NULL REFERENCES orders(id),
  product_id    INTEGER NOT NULL REFERENCES merchant_products(id),
  product_name  TEXT NOT NULL,
  unit_price    INTEGER NOT NULL,
  quantity      INTEGER NOT NULL,
  line_total    INTEGER NOT NULL
);

INSERT INTO order_items (id, order_id, product_id, product_name, unit_price, quantity, line_total)
  SELECT id, order_id, product_id, product_name, unit_price, quantity, line_total
  FROM order_items_pre007;

DROP TABLE order_items_pre007;
DROP TABLE orders_pre007;

CREATE INDEX IF NOT EXISTS idx_orders_merchant ON orders(merchant_id);
CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id);
CREATE INDEX IF NOT EXISTS idx_orders_cart ON orders(cart_id);

-- At most one non-CANCELLED order per cart.
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_cart_active
  ON orders(cart_id) WHERE status != 'CANCELLED';

CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);
