-- Merchant Conversational Learning V1 — additive only.
--
-- merchant_product_aliases: how customers of ONE merchant actually refer to
-- one of that merchant's products ("pizza tôm" -> product 8). Evidence
-- only: an alias never creates, renames or reprices a product — it can only
-- point at an existing merchant_products row of the same merchant.
--   observed_count  : times the phrase was resolved to the product
--   confirmed_count : positive outcomes (not corrected, "đúng", order placed)
--   rejected_count  : negative outcomes (corrected, "không phải", other choice)
--   confidence      : confirmed / (confirmed + 2*rejected + 2)
--   status          : OBSERVED -> CONFIRMED -> TRUSTED, or SUPPRESSED
-- One row per (merchant, phrase, product): the same phrase may carry
-- evidence for two products (a conflict the resolver refuses to use).
CREATE TABLE IF NOT EXISTS merchant_product_aliases (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant_id       TEXT NOT NULL REFERENCES merchants(merchant_id),
  product_id        INTEGER NOT NULL REFERENCES merchant_products(id),
  alias             TEXT NOT NULL,
  normalized_alias  TEXT NOT NULL,
  observed_count    INTEGER NOT NULL DEFAULT 0,
  confirmed_count   INTEGER NOT NULL DEFAULT 0,
  rejected_count    INTEGER NOT NULL DEFAULT 0,
  confidence        REAL NOT NULL DEFAULT 0,
  status            TEXT NOT NULL DEFAULT 'OBSERVED'
                      CHECK (status IN ('OBSERVED', 'CONFIRMED', 'TRUSTED', 'SUPPRESSED')),
  last_seen_at      TEXT NOT NULL DEFAULT (datetime('now')),
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (merchant_id, normalized_alias, product_id)
);

CREATE INDEX IF NOT EXISTS idx_product_aliases_lookup ON merchant_product_aliases(merchant_id, normalized_alias);

-- Audit trail of learning signals. Privacy: only the normalized product
-- phrase is kept (never the customer's message), with the internal
-- customer id needed for "distinct customers" evidence. Pruned after a
-- retention window (ProductLanguageService.pruneEvents).
CREATE TABLE IF NOT EXISTS product_alias_events (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant_id        TEXT NOT NULL REFERENCES merchants(merchant_id),
  customer_id        INTEGER REFERENCES platform_customers(id),
  product_id         INTEGER NOT NULL REFERENCES merchant_products(id),
  normalized_phrase  TEXT NOT NULL,
  resolution_source  TEXT NOT NULL,  -- canonical_name | name_match | learned_alias | context | fuzzy_match | clarification | order_confirmed | accepted | correction
  signal             TEXT NOT NULL CHECK (signal IN ('observed', 'confirmed', 'rejected')),
  confidence_before  REAL,
  confidence_after   REAL,
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_product_alias_events_alias ON product_alias_events(merchant_id, normalized_phrase, product_id);
CREATE INDEX IF NOT EXISTS idx_product_alias_events_created ON product_alias_events(created_at);
