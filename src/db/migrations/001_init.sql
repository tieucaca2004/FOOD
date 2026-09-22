-- Core domain schema for the A Tiểu ordering engine.
-- All money columns are integers (VND, no decimals) — never floats.

CREATE TABLE IF NOT EXISTS customers (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  zalo_user_id  TEXT NOT NULL UNIQUE,
  display_name  TEXT,
  phone         TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id             INTEGER NOT NULL REFERENCES customers(id),
  channel                 TEXT NOT NULL DEFAULT 'zalo',
  current_intent          TEXT,
  pending_confirmation    INTEGER NOT NULL DEFAULT 0, -- 0/1: awaiting order confirm/cancel
  pending_order_id        INTEGER REFERENCES orders(id),
  pending_checkout_field  TEXT,   -- e.g. 'fulfillment_type' | 'phone' | 'address'
  state_json              TEXT,  -- free-form extra context, JSON encoded
  last_interaction_at     TEXT NOT NULL DEFAULT (datetime('now')),
  created_at              TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at              TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS messages (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id    INTEGER NOT NULL REFERENCES sessions(id),
  direction     TEXT NOT NULL, -- 'in' | 'out'
  intent        TEXT,
  raw_text      TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS webhook_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id    TEXT NOT NULL UNIQUE,
  event_name    TEXT,
  response_json TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS categories (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS products (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  sku           TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  category_id   INTEGER REFERENCES categories(id),
  description   TEXT,
  price         INTEGER NOT NULL, -- VND, integer
  image_url     TEXT,
  available     INTEGER NOT NULL DEFAULT 1,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  keywords_json TEXT NOT NULL DEFAULT '[]', -- match tokens for NLP, e.g. ["bo","hu tieu bo"]
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS product_options (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id    INTEGER NOT NULL REFERENCES products(id),
  name          TEXT NOT NULL,
  price_delta   INTEGER NOT NULL DEFAULT 0,
  sort_order    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS carts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id   INTEGER NOT NULL REFERENCES customers(id),
  status        TEXT NOT NULL DEFAULT 'active', -- active | ordered | abandoned
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_carts_customer_active
  ON carts(customer_id) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS cart_items (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  cart_id       INTEGER NOT NULL REFERENCES carts(id),
  product_id    INTEGER NOT NULL REFERENCES products(id),
  quantity      INTEGER NOT NULL,
  unit_price    INTEGER NOT NULL, -- snapshot of product.price at add time
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS orders (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  order_code        TEXT NOT NULL UNIQUE,
  customer_id       INTEGER NOT NULL REFERENCES customers(id),
  cart_id           INTEGER NOT NULL REFERENCES carts(id),
  status            TEXT NOT NULL DEFAULT 'DRAFT',
  fulfillment_type  TEXT,   -- dine_in | takeaway | delivery
  customer_name     TEXT,
  customer_phone    TEXT,
  delivery_address  TEXT,
  subtotal          INTEGER NOT NULL DEFAULT 0,
  delivery_fee      INTEGER NOT NULL DEFAULT 0,
  total             INTEGER NOT NULL DEFAULT 0,
  note              TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS order_items (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id      INTEGER NOT NULL REFERENCES orders(id),
  product_id    INTEGER NOT NULL REFERENCES products(id),
  product_name  TEXT NOT NULL, -- snapshot
  unit_price    INTEGER NOT NULL, -- snapshot
  quantity      INTEGER NOT NULL,
  line_total    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS order_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id      INTEGER NOT NULL REFERENCES orders(id),
  from_status   TEXT,
  to_status     TEXT NOT NULL,
  note          TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS business_settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS promotions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  code            TEXT NOT NULL UNIQUE,
  description     TEXT,
  discount_type   TEXT NOT NULL, -- 'percent' | 'fixed'
  discount_value  INTEGER NOT NULL,
  active          INTEGER NOT NULL DEFAULT 0,
  starts_at       TEXT,
  ends_at         TEXT
);

CREATE TABLE IF NOT EXISTS notifications (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id      INTEGER REFERENCES orders(id),
  channel       TEXT NOT NULL, -- 'telegram' | 'log'
  status        TEXT NOT NULL, -- 'sent' | 'failed' | 'skipped_no_channel'
  payload       TEXT,
  error         TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sessions_customer ON sessions(customer_id);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_id);
CREATE INDEX IF NOT EXISTS idx_cart_items_cart ON cart_items(cart_id);
CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id);
CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_order_events_order ON order_events(order_id);
