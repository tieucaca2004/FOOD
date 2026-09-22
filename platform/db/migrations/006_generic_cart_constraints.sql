-- Phase 5 security gate: quantity > 0 must hold at the database level too,
-- not only in CartService — defense in depth (spec §55) against any bug
-- that bypasses application validation. SQLite has no ALTER TABLE ... ADD
-- CONSTRAINT, so adding a CHECK to an existing table means the standard
-- SQLite rebuild dance: rename -> recreate with the constraint -> copy
-- rows -> drop the old table -> recreate indexes (dropped along with the
-- old table). No data is lost; this table has no rows yet in any real
-- deployment, but the migration is written correctly for one that does.

ALTER TABLE merchant_cart_items RENAME TO merchant_cart_items_pre006;

CREATE TABLE merchant_cart_items (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  cart_id       INTEGER NOT NULL REFERENCES merchant_carts(id),
  merchant_id   TEXT NOT NULL REFERENCES merchants(merchant_id),
  product_id    INTEGER NOT NULL REFERENCES merchant_products(id),
  product_name  TEXT NOT NULL,
  unit_price    INTEGER NOT NULL,
  quantity      INTEGER NOT NULL CHECK (quantity > 0),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO merchant_cart_items (id, cart_id, merchant_id, product_id, product_name, unit_price, quantity, created_at, updated_at)
  SELECT id, cart_id, merchant_id, product_id, product_name, unit_price, quantity, created_at, updated_at
  FROM merchant_cart_items_pre006;

DROP TABLE merchant_cart_items_pre006;

CREATE UNIQUE INDEX IF NOT EXISTS idx_merchant_cart_items_cart_product
  ON merchant_cart_items(cart_id, product_id);

CREATE INDEX IF NOT EXISTS idx_merchant_cart_items_cart ON merchant_cart_items(cart_id);
