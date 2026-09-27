-- Merchant identifiers (dedup anchors) and recorded source conflicts.

-- Stable identifiers a source gives a merchant (OSM element, website,
-- phone, map place id…). A strong identifier seen again means "same
-- merchant"; UNIQUE(scheme, value) prevents two merchants claiming it.
CREATE TABLE IF NOT EXISTS kb_merchant_identifiers (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant_id INTEGER NOT NULL REFERENCES kb_merchants(id),
  scheme      TEXT NOT NULL CHECK (scheme IN ('osm', 'website', 'phone', 'maps_place_id', 'source_url', 'official_snapshot')),
  value       TEXT NOT NULL,
  evidence_id INTEGER NOT NULL REFERENCES kb_evidence(id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (scheme, value)
);
CREATE INDEX IF NOT EXISTS idx_kb_merchant_identifiers_merchant ON kb_merchant_identifiers(merchant_id);

-- Two sources disagree about the same thing (a price, opening hours, an
-- address…). Nothing is chosen: every row stays, flagged conflict = 1, and
-- the disagreement is recorded here for review. Variants ("nhỏ"/"lớn") and
-- the same source over time (history) are NOT conflicts.
CREATE TABLE IF NOT EXISTS kb_source_conflicts (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  subject_type    TEXT NOT NULL CHECK (subject_type IN ('merchant_claim', 'location', 'price', 'rating')),
  subject_key     TEXT NOT NULL,             -- e.g. "merchant:5:opening_hours", "product:12:price:<variant>"
  row_ids_json    TEXT NOT NULL,             -- the disagreeing rows
  detected_at     TEXT NOT NULL DEFAULT (datetime('now')),
  status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  resolution_note TEXT,
  UNIQUE (subject_type, subject_key, row_ids_json)
);

-- a rating platform read through two different sites can disagree
ALTER TABLE kb_merchant_ratings ADD COLUMN conflict INTEGER NOT NULL DEFAULT 0;
