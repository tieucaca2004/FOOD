-- Phase 3 (revision): the Menu entity was missing entirely — categories/
-- products existed but "the menu" itself had no row, no lifecycle status.
-- One menu per merchant (UNIQUE merchant_id) is enough for the generic
-- engine today — categories/products keep referencing merchant_id
-- directly (not menu_id), so this stays additive and doesn't touch any
-- existing table's shape.
--
-- No backfill: a merchant with no row here is treated as "implicitly
-- visible" (legacy behavior, preserved) — only once a menu row exists
-- does its status (DRAFT/PUBLISHED/ARCHIVED) start gating customer-facing
-- visibility. See platform/services/menuService.js.

CREATE TABLE IF NOT EXISTS merchant_menus (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant_id   TEXT NOT NULL UNIQUE REFERENCES merchants(merchant_id),
  name          TEXT,
  status        TEXT NOT NULL DEFAULT 'DRAFT', -- DRAFT | PUBLISHED | ARCHIVED
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
