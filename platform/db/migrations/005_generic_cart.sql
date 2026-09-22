-- Phase 5: Generic Cart Engine. One cart per (customer, merchant) pair
-- while ACTIVE — this is what makes "ONE CART = ONE MERCHANT" true by
-- construction: a cart's merchant_id never changes after creation, so
-- there is no code path that could mix two merchants' products into one
-- cart. A customer may hold separate ACTIVE carts for different
-- merchants at the same time (e.g. one for ATIEU001, one for MERCHANT002)
-- — that is normal multi-merchant shopping, not a mixing violation.
--
-- unit_price/product_name are snapshotted at add-time (spec §18) — never
-- re-read from the live product row once an item exists, so a later menu
-- price change never silently reprices something already in a cart.
--
-- subtotal is intentionally NOT a stored column — it's always
-- unit_price * quantity, so storing it would just be redundant data that
-- could drift; CartService computes it on read (spec §7: "không lưu dữ
-- liệu thừa nếu chưa cần").

CREATE TABLE IF NOT EXISTS merchant_carts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant_id   TEXT NOT NULL REFERENCES merchants(merchant_id),
  customer_id   INTEGER NOT NULL REFERENCES platform_customers(id),
  status        TEXT NOT NULL DEFAULT 'ACTIVE', -- ACTIVE only in Phase 5 (no checkout/order yet)
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_merchant_carts_customer_merchant
  ON merchant_carts(customer_id, merchant_id) WHERE status = 'ACTIVE';

CREATE TABLE IF NOT EXISTS merchant_cart_items (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  cart_id       INTEGER NOT NULL REFERENCES merchant_carts(id),
  merchant_id   TEXT NOT NULL REFERENCES merchants(merchant_id), -- denormalized for fast cross-merchant-mismatch checks
  product_id    INTEGER NOT NULL REFERENCES merchant_products(id),
  product_name  TEXT NOT NULL, -- snapshot at add-time
  unit_price    INTEGER NOT NULL, -- snapshot at add-time, VND integer
  quantity      INTEGER NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- No modifiers/options in Phase 5 (deferred — spec §23), so one row per
-- (cart, product) is enough; this also closes the concurrency gap spec
-- §22 calls out (two simultaneous "add" calls can't create duplicate rows
-- for the same product — the second INSERT fails the constraint and the
-- service falls back to an UPDATE).
CREATE UNIQUE INDEX IF NOT EXISTS idx_merchant_cart_items_cart_product
  ON merchant_cart_items(cart_id, product_id);

CREATE INDEX IF NOT EXISTS idx_merchant_cart_items_cart ON merchant_cart_items(cart_id);
