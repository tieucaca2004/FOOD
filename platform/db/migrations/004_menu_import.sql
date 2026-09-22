-- Phase 4: Menu Import Engine. A staging area in front of the Generic
-- Menu Engine (merchant_categories/merchant_products/merchant_menus) —
-- nothing here is ever read by Discovery/GenericMerchantAdapter directly;
-- only a PUBLISHED import's data, once applied through MenuService, ever
-- becomes customer-visible.
--
-- The parsed/edited draft is kept as a single JSON blob (draft_json)
-- rather than its own normalized category/product tables — it's a
-- transient staging structure the service layer validates as a whole,
-- not a queryable catalog; a full relational schema for it would be
-- premature complexity for what disappears once published.

CREATE TABLE IF NOT EXISTS merchant_menu_imports (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant_id       TEXT NOT NULL REFERENCES merchants(merchant_id),
  source_type       TEXT NOT NULL, -- TEXT | IMAGE
  source_reference  TEXT,          -- raw text (TEXT) or storage ref (IMAGE) — never a client-supplied path
  status            TEXT NOT NULL DEFAULT 'PROCESSING',
    -- PROCESSING | DRAFT | REVIEW_REQUIRED | APPROVED | REJECTED | FAILED | PUBLISHED
  draft_json        TEXT,          -- MenuDraft: {categories:[{name, products:[{name, price, description, available, keywords, confidence, needs_review, possible_duplicate}]}]}
  error_message     TEXT,          -- set when status = FAILED
  reject_reason     TEXT,          -- set when status = REJECTED
  created_by        TEXT,          -- opaque actor id — no auth layer yet, never trusted for authorization
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_menu_imports_merchant ON merchant_menu_imports(merchant_id);
