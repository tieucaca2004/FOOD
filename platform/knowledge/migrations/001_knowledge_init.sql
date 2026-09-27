-- Food Knowledge DB (knowledge.db) — a SEPARATE SQLite database, never the
-- platform DB. Food knowledge describes the world of dishes; it never says
-- what a merchant sells, at what price, or whether anything can be ordered
-- (that is only ever the platform catalog: merchant_products / menus).
--
-- Every published fact is a CLAIM that points at EVIDENCE (a verbatim quote
-- located in a stored raw source). No evidence -> no claim -> "unknown".
-- Lifecycle of entities, names and claims: draft -> review -> published
-- (or rejected). Collectors and LLMs only ever create proposals; the
-- validator (platform/knowledge/validator.js) decides.

CREATE TABLE IF NOT EXISTS kb_sources (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  url                 TEXT NOT NULL,
  domain              TEXT,
  source_type         TEXT NOT NULL,        -- validated against taxonomy.source_types
  license             TEXT,                 -- e.g. "ODbL-1.0" for OSM
  attribution         TEXT,
  fetched_at          TEXT NOT NULL,
  source_published_at TEXT,
  content_type        TEXT NOT NULL,        -- text/html | text/plain | application/json
  content_hash        TEXT NOT NULL,        -- sha256 of the raw file, computed by the store
  raw_path            TEXT NOT NULL,        -- the immutable raw copy the evidence is checked against
  robots_allowed      INTEGER,              -- 1/0/NULL (not applicable, e.g. an API)
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (url, content_hash)
);

-- Versioned administrative regions (boundaries change: valid_from/valid_to).
CREATE TABLE IF NOT EXISTS kb_regions (
  id          TEXT PRIMARY KEY,             -- "vn", "vn.khanh-hoa", "vn.khanh-hoa.nha-trang"
  name        TEXT NOT NULL,
  parent_id   TEXT REFERENCES kb_regions(id),
  level       TEXT NOT NULL CHECK (level IN ('country', 'province', 'locality', 'ward')),
  valid_from  TEXT,
  valid_to    TEXT
);

CREATE TABLE IF NOT EXISTS kb_food_entities (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  key             TEXT NOT NULL UNIQUE,     -- stable slug, e.g. "bun-ca"
  canonical_name  TEXT NOT NULL,            -- original spelling, accents kept
  normalized_name TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'review', 'published', 'rejected', 'retired')),
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS kb_evidence (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id          INTEGER NOT NULL REFERENCES kb_sources(id),
  quote              TEXT NOT NULL,         -- verbatim text from the raw source
  locator            TEXT,                  -- where in the source (selector, paragraph…)
  extraction         TEXT NOT NULL CHECK (extraction IN ('explicit', 'llm_proposal', 'rule', 'curated')),
  proposed_by        TEXT,                  -- collector / model id / person
  captured_at        TEXT NOT NULL DEFAULT (datetime('now')),
  verification       TEXT NOT NULL DEFAULT 'pending' CHECK (verification IN ('pending', 'verified', 'failed')),
  verification_error TEXT,
  verified_at        TEXT
);

-- Names of an entity: canonical, aliases, unaccented forms, misspellings,
-- regional and foreign names. A derived form (unaccented spelling) is a
-- transformation, not a fact, and carries no evidence.
CREATE TABLE IF NOT EXISTS kb_food_names (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_id   INTEGER NOT NULL REFERENCES kb_food_entities(id),
  name        TEXT NOT NULL,
  normalized  TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('canonical', 'alias', 'no_accent', 'misspelling', 'regional', 'english')),
  region_id   TEXT REFERENCES kb_regions(id),
  origin      TEXT NOT NULL CHECK (origin IN ('sourced', 'derived', 'curated')),
  evidence_id INTEGER REFERENCES kb_evidence(id),
  status      TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'review', 'published', 'rejected')),
  review_reason TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (entity_id, normalized, kind)
);

-- One generic claim table: facet membership, attributes (taste, serving
-- temperature, texture…), ingredients, ingredient-list completeness,
-- relations and descriptions all share one validation path.
CREATE TABLE IF NOT EXISTS kb_claims (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_id         INTEGER NOT NULL REFERENCES kb_food_entities(id),
  kind              TEXT NOT NULL CHECK (kind IN ('facet', 'attribute', 'ingredient', 'ingredient_completeness', 'relation', 'description')),
  key               TEXT NOT NULL,          -- facet id / attribute id / ingredient key / relation type / "description"
  value             TEXT,                   -- facet node / attribute value / ingredient role / related entity key / text
  level             TEXT,                   -- attribute level (none|low|medium|high|varies|adjustable)
  necessity         TEXT CHECK (necessity IS NULL OR necessity IN ('always', 'usually', 'optional')),
  scope             TEXT NOT NULL DEFAULT 'typical' CHECK (scope IN ('typical', 'variant', 'region')),
  region_id         TEXT REFERENCES kb_regions(id),
  related_entity_id INTEGER REFERENCES kb_food_entities(id),
  evidence_id       INTEGER NOT NULL REFERENCES kb_evidence(id),
  confidence        REAL,                   -- computed by the store, never taken from a proposal
  status            TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'review', 'published', 'rejected')),
  review_reason     TEXT,
  conflict          INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_kb_claims_entity ON kb_claims(entity_id, kind, key);
CREATE INDEX IF NOT EXISTS idx_kb_claims_status ON kb_claims(status);
CREATE INDEX IF NOT EXISTS idx_kb_names_normalized ON kb_food_names(normalized);
CREATE INDEX IF NOT EXISTS idx_kb_evidence_source ON kb_evidence(source_id);

-- Read views: only what has been published, with its evidence.
CREATE VIEW IF NOT EXISTS kb_published_claims AS
  SELECT c.*, e.key AS entity_key, e.canonical_name, ev.quote, ev.extraction, s.url AS source_url, s.source_type,
         s.fetched_at, s.source_published_at
  FROM kb_claims c
  JOIN kb_food_entities e ON e.id = c.entity_id
  JOIN kb_evidence ev ON ev.id = c.evidence_id
  JOIN kb_sources s ON s.id = ev.source_id
  WHERE c.status = 'published' AND e.status = 'published';

CREATE VIEW IF NOT EXISTS kb_published_names AS
  SELECT n.*, e.key AS entity_key
  FROM kb_food_names n JOIN kb_food_entities e ON e.id = n.entity_id
  WHERE n.status = 'published' AND e.status = 'published';
