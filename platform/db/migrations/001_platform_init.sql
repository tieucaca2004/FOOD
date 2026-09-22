-- Platform-level schema for the Tổng Đài marketplace layer. Merchant
-- modules (e.g. A Tiểu) own their own data in their own DB — nothing here
-- duplicates a merchant's order-of-record; see order ownership note in
-- platform/repositories/orderRepository.js.

CREATE TABLE IF NOT EXISTS plans (
  plan_id     TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  price       INTEGER NOT NULL DEFAULT 0, -- VND/month, 0 = free tier
  trial_days  INTEGER,                    -- NULL = use platform default_trial_days
  active      INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS merchants (
  merchant_id   TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  slug          TEXT NOT NULL UNIQUE,
  module        TEXT NOT NULL,   -- 'atieu' | 'generic' | future module keys
  status        TEXT NOT NULL DEFAULT 'PENDING',
    -- PENDING | TRIAL | ACTIVE | SUSPENDED | EXPIRED | CLOSED
  logo_url      TEXT,
  cover_image_url TEXT,
  description   TEXT,
  address       TEXT,
  phone         TEXT,
  latitude      REAL,
  longitude     REAL,
  opening_hours_json TEXT,  -- structured schedule if known; NULL = unknown (never guess open/closed)
  sponsored     INTEGER NOT NULL DEFAULT 0, -- paid promotion flag — must be surfaced, never disguised as organic
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS merchant_users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant_id   TEXT NOT NULL REFERENCES merchants(merchant_id),
  name          TEXT,
  phone         TEXT,
  role          TEXT NOT NULL DEFAULT 'owner',
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS merchant_settings (
  merchant_id   TEXT NOT NULL REFERENCES merchants(merchant_id),
  key           TEXT NOT NULL,
  value         TEXT,
  PRIMARY KEY (merchant_id, key)
);

CREATE TABLE IF NOT EXISTS merchant_subscriptions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant_id   TEXT NOT NULL REFERENCES merchants(merchant_id),
  plan_id       TEXT NOT NULL REFERENCES plans(plan_id),
  status        TEXT NOT NULL DEFAULT 'TRIAL', -- TRIAL | ACTIVE | SUBSCRIPTION_REQUIRED | CANCELLED
  trial_started_at TEXT,
  trial_ends_at TEXT,
  started_at    TEXT,
  expires_at    TEXT,
  auto_renew    INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Catalog for "generic" (data-driven, no dedicated code module) merchants
-- only. A Tiểu's real catalog stays in its own module DB untouched.
CREATE TABLE IF NOT EXISTS merchant_categories (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant_id   TEXT NOT NULL REFERENCES merchants(merchant_id),
  name          TEXT NOT NULL,
  sort_order    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS merchant_products (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant_id   TEXT NOT NULL REFERENCES merchants(merchant_id),
  sku           TEXT NOT NULL,
  name          TEXT NOT NULL,
  category_id   INTEGER REFERENCES merchant_categories(id),
  description   TEXT,
  price         INTEGER NOT NULL,
  image_url     TEXT,
  available     INTEGER NOT NULL DEFAULT 1,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  keywords_json TEXT NOT NULL DEFAULT '[]',
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (merchant_id, sku)
);

CREATE TABLE IF NOT EXISTS platform_customers (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  zalo_user_id  TEXT NOT NULL UNIQUE, -- Tổng Đài OA's own Zalo user id
  display_name  TEXT,
  phone         TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS platform_sessions (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id         INTEGER NOT NULL REFERENCES platform_customers(id),
  context             TEXT NOT NULL DEFAULT 'platform', -- 'platform' | 'merchant'
  active_merchant_id  TEXT REFERENCES merchants(merchant_id),
  last_search_query   TEXT,
  last_search_results_json TEXT, -- [{merchant_id, name}] for "chọn quán" follow-up
  last_interaction_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS platform_messages (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id    INTEGER NOT NULL REFERENCES platform_sessions(id),
  direction     TEXT NOT NULL, -- 'in' | 'out'
  intent        TEXT,
  raw_text      TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One row per "customer X opened merchant Y" — a thin marker for analytics
-- and "which merchant is this customer currently in". Actual conversation
-- state (cart, checkout) lives inside the merchant module's own session.
CREATE TABLE IF NOT EXISTS merchant_sessions (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  platform_session_id INTEGER NOT NULL REFERENCES platform_sessions(id),
  merchant_id       TEXT NOT NULL REFERENCES merchants(merchant_id),
  entry_source      TEXT NOT NULL DEFAULT 'platform_search',
  search_query      TEXT,
  selected_product_ref TEXT,
  opened_at         TEXT NOT NULL DEFAULT (datetime('now')),
  closed_at         TEXT
);

-- Orders for "generic" (data-driven) merchants only — schema-ready per spec
-- §27/§23. A Tiểu's orders remain the source of truth inside its own module
-- DB; platform never duplicates them here (see merchant_events for the
-- analytics-only reference).
CREATE TABLE IF NOT EXISTS orders (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  order_code        TEXT NOT NULL UNIQUE,
  merchant_id       TEXT NOT NULL REFERENCES merchants(merchant_id),
  customer_id       INTEGER NOT NULL REFERENCES platform_customers(id),
  status            TEXT NOT NULL DEFAULT 'DRAFT',
  subtotal          INTEGER NOT NULL DEFAULT 0,
  delivery_fee      INTEGER NOT NULL DEFAULT 0,
  discount          INTEGER NOT NULL DEFAULT 0,
  total             INTEGER NOT NULL DEFAULT 0,
  payment_status    TEXT NOT NULL DEFAULT 'PENDING',
  delivery_status   TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS order_items (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id      INTEGER NOT NULL REFERENCES orders(id),
  product_id    INTEGER NOT NULL REFERENCES merchant_products(id),
  product_name  TEXT NOT NULL,
  unit_price    INTEGER NOT NULL,
  quantity      INTEGER NOT NULL,
  line_total    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS payments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id      INTEGER NOT NULL REFERENCES orders(id),
  provider      TEXT NOT NULL DEFAULT 'none', -- 'none' until a real PaymentProvider is integrated
  status        TEXT NOT NULL DEFAULT 'PENDING', -- PENDING|AUTHORIZED|PAID|FAILED|REFUNDED
  amount        INTEGER NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS deliveries (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id      INTEGER NOT NULL REFERENCES orders(id),
  provider      TEXT NOT NULL DEFAULT 'none', -- 'none' until a real DeliveryProvider is integrated
  status        TEXT NOT NULL DEFAULT 'UNASSIGNED',
  quote_amount  INTEGER,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS search_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id   INTEGER REFERENCES platform_customers(id),
  query_text    TEXT NOT NULL,
  result_count  INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Cross-cutting funnel events: SEARCH, MERCHANT_VIEW, PRODUCT_VIEW,
-- ADD_TO_CART, CHECKOUT_STARTED, ORDER_CREATED, ORDER_PAID, ORDER_COMPLETED.
-- For A Tiểu, ORDER_CREATED/etc. carry external_ref = A Tiểu's order_code —
-- a reference, not a copy of the order-of-record.
CREATE TABLE IF NOT EXISTS merchant_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant_id   TEXT REFERENCES merchants(merchant_id),
  customer_id   INTEGER REFERENCES platform_customers(id),
  event_type    TEXT NOT NULL,
  external_ref  TEXT,   -- e.g. A Tiểu's order_code, when event is order-related
  payload_json  TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS platform_webhook_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id    TEXT NOT NULL UNIQUE,
  event_name    TEXT,
  response_json TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_merchant_products_merchant ON merchant_products(merchant_id);
CREATE INDEX IF NOT EXISTS idx_merchant_categories_merchant ON merchant_categories(merchant_id);
CREATE INDEX IF NOT EXISTS idx_platform_sessions_customer ON platform_sessions(customer_id);
CREATE INDEX IF NOT EXISTS idx_platform_messages_session ON platform_messages(session_id);
CREATE INDEX IF NOT EXISTS idx_merchant_sessions_platform_session ON merchant_sessions(platform_session_id);
CREATE INDEX IF NOT EXISTS idx_orders_merchant ON orders(merchant_id);
CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id);
CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_merchant_events_merchant ON merchant_events(merchant_id);
CREATE INDEX IF NOT EXISTS idx_search_events_customer ON search_events(customer_id);
