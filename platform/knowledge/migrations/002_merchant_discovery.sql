-- Food ↔ Merchant discovery layer of knowledge.db (still a LOCAL, SEPARATE
-- database — never the platform DB, never production merchant_products).
--
--   kb_food_entities  N ──< kb_food_product_links >── N  kb_merchant_products  N ──> 1  kb_merchants
--                                         └──────────── N  (platform product, by id: ORDERABLE catalog)
--
-- - A food is sold by many merchants; a merchant sells many foods. Nothing is
--   copied between them: merchant data lives on kb_merchants, prices on the
--   merchant's product, ratings on the merchant + rating source.
-- - DISCOVERY ≠ ORDERING. Everything here is reference data ("source X says
--   merchant A lists bún cá at 45.000đ on <date>"). Only a merchant bridged to
--   the platform (kb_merchant_links) and a product that exists in the
--   platform catalog can be ordered; that is always checked in the platform.
-- - Every fact row points at kb_evidence (source + verbatim quote) and carries
--   captured_at / last_seen_at: nothing here is realtime.

-- ------------------------------------------------------------------ merchants

CREATE TABLE IF NOT EXISTS kb_merchants (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  key             TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL,             -- display name as found (brand spelling kept)
  normalized_name TEXT NOT NULL,             -- search/dedup key only
  status          TEXT NOT NULL DEFAULT 'candidate'
                    CHECK (status IN ('candidate', 'verified', 'closed', 'duplicate', 'rejected')),
  duplicate_of_id INTEGER REFERENCES kb_merchants(id),
  first_seen_at   TEXT NOT NULL,
  last_seen_at    TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (status != 'duplicate' OR duplicate_of_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_kb_merchants_normalized ON kb_merchants(normalized_name);

-- Every other merchant fact, one row per (field, source observation).
-- Unknown = no row. Conflicting values are kept side by side (conflict = 1).
CREATE TABLE IF NOT EXISTS kb_merchant_claims (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant_id   INTEGER NOT NULL REFERENCES kb_merchants(id),
  field         TEXT NOT NULL CHECK (field IN (
                  'name', 'business_type', 'cuisine', 'description', 'phone', 'website', 'facebook', 'instagram',
                  'maps_url', 'opening_hours', 'open_status', 'delivery', 'takeaway', 'dine_in')),
  value_json    TEXT,                        -- structured value (opening_hours: {"mon": [["06:00","10:00"]], …})
  original_text TEXT NOT NULL,               -- as the source wrote it ("6h - 10h sáng")
  evidence_id   INTEGER NOT NULL REFERENCES kb_evidence(id),
  captured_at   TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL,
  confidence    REAL,
  status        TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'review', 'published', 'rejected')),
  review_reason TEXT,
  conflict      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_kb_merchant_claims ON kb_merchant_claims(merchant_id, field, status);

-- Location evidence. Coordinates may be missing (NULL) — never guessed.
CREATE TABLE IF NOT EXISTS kb_merchant_locations (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant_id      INTEGER NOT NULL REFERENCES kb_merchants(id),
  address_original TEXT NOT NULL,            -- verbatim; old and new administrative names both kept
  street           TEXT,
  ward             TEXT,
  area             TEXT,                     -- informal area/neighbourhood as the source names it
  city             TEXT,
  province         TEXT,
  region_id        TEXT REFERENCES kb_regions(id),
  latitude         REAL CHECK (latitude IS NULL OR latitude BETWEEN -90 AND 90),
  longitude        REAL CHECK (longitude IS NULL OR longitude BETWEEN -180 AND 180),
  coordinates_from TEXT CHECK (coordinates_from IS NULL OR coordinates_from IN ('source', 'geocoder', 'manual')),
  evidence_id      INTEGER NOT NULL REFERENCES kb_evidence(id),
  captured_at      TEXT NOT NULL,
  last_seen_at     TEXT NOT NULL,
  confidence       REAL,
  status           TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'review', 'published', 'rejected')),
  conflict         INTEGER NOT NULL DEFAULT 0,
  CHECK ((latitude IS NULL) = (longitude IS NULL)),
  CHECK (latitude IS NULL OR coordinates_from IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_kb_merchant_locations_geo ON kb_merchant_locations(latitude, longitude);
CREATE INDEX IF NOT EXISTS idx_kb_merchant_locations_merchant ON kb_merchant_locations(merchant_id, status);

-- Ratings belong to ONE merchant as measured by ONE rating source at ONE
-- time. Never aggregated across sources, never transferred to a food.
CREATE TABLE IF NOT EXISTS kb_merchant_ratings (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant_id   INTEGER NOT NULL REFERENCES kb_merchants(id),
  rating_source TEXT NOT NULL,               -- which platform/site produced the rating
  rating        REAL,                        -- NULL when the source shows none
  rating_scale  REAL NOT NULL DEFAULT 5,
  review_count  INTEGER CHECK (review_count IS NULL OR review_count >= 0),
  evidence_id   INTEGER NOT NULL REFERENCES kb_evidence(id),
  captured_at   TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'review', 'published', 'rejected')),
  CHECK (rating IS NULL OR (rating >= 0 AND rating <= rating_scale)),
  CHECK (rating IS NOT NULL OR review_count IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_kb_merchant_ratings ON kb_merchant_ratings(merchant_id, rating_source, captured_at);

-- The ONLY bridge from discovery to ordering: this reference merchant IS that
-- onboarded platform merchant. Created by a person, never by a collector.
CREATE TABLE IF NOT EXISTS kb_merchant_links (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  kb_merchant_id       INTEGER NOT NULL UNIQUE REFERENCES kb_merchants(id),
  platform_merchant_id TEXT NOT NULL UNIQUE,  -- platform merchants.merchant_id (other DB: checked at read time)
  linked_by            TEXT NOT NULL,
  linked_at            TEXT NOT NULL DEFAULT (datetime('now')),
  note                 TEXT
);

-- Possible duplicates are never merged automatically unless a strong
-- identifier matches; otherwise a person decides.
CREATE TABLE IF NOT EXISTS kb_duplicate_candidates (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant_a   INTEGER NOT NULL REFERENCES kb_merchants(id),
  merchant_b   INTEGER NOT NULL REFERENCES kb_merchants(id),
  signals_json TEXT NOT NULL,                -- which signals matched (distance, phone, place id, name…)
  score        REAL,
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'merged', 'distinct')),
  decided_by   TEXT,
  decided_at   TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (merchant_a < merchant_b),
  CHECK (status = 'pending' OR decided_by IS NOT NULL),
  UNIQUE (merchant_a, merchant_b)
);

-- ------------------------------------------------------------------ menus / products / prices

-- One menu per observation of a source (a menu page, a price board…).
CREATE TABLE IF NOT EXISTS kb_menus (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant_id         INTEGER NOT NULL REFERENCES kb_merchants(id),
  name                TEXT,
  evidence_id         INTEGER NOT NULL REFERENCES kb_evidence(id),
  captured_at         TEXT NOT NULL,
  source_published_at TEXT,
  last_seen_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS kb_menu_categories (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  menu_id    INTEGER NOT NULL REFERENCES kb_menus(id),
  name       TEXT NOT NULL,                  -- as written by the merchant
  sort_order INTEGER NOT NULL DEFAULT 0
);

-- A dish as a merchant lists it (REFERENCE, not orderable). Only created
-- when a source shows the merchant listing it; never derived from a food.
CREATE TABLE IF NOT EXISTS kb_merchant_products (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant_id     INTEGER NOT NULL REFERENCES kb_merchants(id),
  menu_id         INTEGER REFERENCES kb_menus(id),
  category_id     INTEGER REFERENCES kb_menu_categories(id),
  original_name   TEXT NOT NULL,             -- the merchant's own wording
  normalized_name TEXT NOT NULL,
  description     TEXT,                      -- the merchant's own words only
  availability    TEXT NOT NULL DEFAULT 'unknown' CHECK (availability IN ('active', 'unknown', 'inactive')),
  evidence_id     INTEGER NOT NULL REFERENCES kb_evidence(id),
  status          TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'review', 'published', 'rejected')),
  first_seen_at   TEXT NOT NULL,
  last_seen_at    TEXT NOT NULL,
  UNIQUE (merchant_id, normalized_name)
);
CREATE INDEX IF NOT EXISTS idx_kb_merchant_products_merchant ON kb_merchant_products(merchant_id, status);
CREATE INDEX IF NOT EXISTS idx_kb_merchant_products_name ON kb_merchant_products(normalized_name);

-- Price evidence = price history of ONE merchant product (append-only).
-- A food never has a price. No price shown -> price NULL, original text kept.
CREATE TABLE IF NOT EXISTS kb_product_prices (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id          INTEGER NOT NULL REFERENCES kb_merchant_products(id),
  variant             TEXT,                  -- "nhỏ", "lớn", "đặc biệt"… NULL = the only price
  price               INTEGER CHECK (price IS NULL OR price >= 0),
  price_max           INTEGER CHECK (price_max IS NULL OR price_max >= price), -- a range "45–60k"
  currency            TEXT NOT NULL DEFAULT 'VND',
  unit                TEXT,                  -- portion, bowl, kg…
  price_text_original TEXT NOT NULL,         -- "45K", "45.000đ"
  evidence_id         INTEGER NOT NULL REFERENCES kb_evidence(id),
  captured_at         TEXT NOT NULL,
  source_published_at TEXT,
  last_seen_at        TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'review', 'published', 'rejected')),
  conflict            INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_kb_product_prices ON kb_product_prices(product_id, variant, captured_at);

-- ------------------------------------------------------------------ food ↔ product links

-- N:M between food entities and merchant products — reference products
-- here, or ORDERABLE platform products by id. A combo product links to
-- several foods (link_role 'component') instead of being duplicated.
-- Only an exact name/alias match may publish without a person; alias,
-- variant and semantic links need a reviewer (never "the names look alike").
CREATE TABLE IF NOT EXISTS kb_food_product_links (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  food_entity_id       INTEGER NOT NULL REFERENCES kb_food_entities(id),
  kb_product_id        INTEGER REFERENCES kb_merchant_products(id),
  platform_merchant_id TEXT,                 -- orderable target (platform DB, checked at read time)
  platform_product_id  INTEGER,
  match_type           TEXT NOT NULL CHECK (match_type IN ('exact', 'alias', 'variant', 'semantic', 'manual')),
  link_role            TEXT NOT NULL DEFAULT 'primary' CHECK (link_role IN ('primary', 'component')),
  confidence           REAL,
  evidence_id          INTEGER REFERENCES kb_evidence(id),
  status               TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'review', 'published', 'rejected')),
  decided_by           TEXT,
  review_reason        TEXT,
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at           TEXT NOT NULL DEFAULT (datetime('now')),
  -- exactly one target: a reference product XOR a platform product
  CHECK ((kb_product_id IS NOT NULL) + (platform_product_id IS NOT NULL) = 1),
  CHECK ((platform_product_id IS NULL) = (platform_merchant_id IS NULL)),
  CHECK (match_type != 'manual' OR decided_by IS NOT NULL),
  CHECK (match_type = 'manual' OR evidence_id IS NOT NULL),
  CHECK (status != 'published' OR match_type IN ('exact', 'manual') OR decided_by IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_kb_links_kb_product ON kb_food_product_links(food_entity_id, kb_product_id) WHERE kb_product_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_kb_links_platform ON kb_food_product_links(food_entity_id, platform_merchant_id, platform_product_id) WHERE platform_product_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_kb_links_product ON kb_food_product_links(kb_product_id);

-- ------------------------------------------------------------------ opinions about a food

-- A source's review/opinion ABOUT a dish (at a merchant, or in general):
-- kept as a signal with its source and time, never turned into a fact.
CREATE TABLE IF NOT EXISTS kb_food_review_signals (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  food_entity_id INTEGER REFERENCES kb_food_entities(id),
  kb_product_id  INTEGER REFERENCES kb_merchant_products(id),
  kb_merchant_id INTEGER REFERENCES kb_merchants(id),
  kind           TEXT NOT NULL CHECK (kind IN ('opinion', 'dish_rating')),
  signal_text    TEXT NOT NULL,              -- verbatim
  rating         REAL,
  rating_scale   REAL,
  evidence_id    INTEGER NOT NULL REFERENCES kb_evidence(id),
  captured_at    TEXT NOT NULL,
  CHECK (food_entity_id IS NOT NULL OR kb_product_id IS NOT NULL),
  CHECK (rating IS NULL OR (rating_scale IS NOT NULL AND rating >= 0 AND rating <= rating_scale))
);

-- ------------------------------------------------------------------ read views (published only)

-- Food -> the merchants listing it (one row per food × product). The
-- platform path appears with its ids only; the runtime checks the platform
-- catalog before calling anything orderable.
CREATE VIEW IF NOT EXISTS kb_v_food_merchant_products AS
  SELECT l.id AS link_id, f.id AS food_entity_id, f.key AS food_key, f.canonical_name AS food_name,
         l.match_type, l.link_role, l.confidence AS link_confidence,
         p.id AS kb_product_id, p.original_name AS product_name, p.availability,
         m.id AS kb_merchant_id, m.name AS merchant_name, m.status AS merchant_status,
         ml.platform_merchant_id AS bridged_platform_merchant_id,
         l.platform_merchant_id, l.platform_product_id,
         p.last_seen_at AS product_last_seen_at
  FROM kb_food_product_links l
  JOIN kb_food_entities f ON f.id = l.food_entity_id AND f.status = 'published'
  LEFT JOIN kb_merchant_products p ON p.id = l.kb_product_id AND p.status = 'published'
  LEFT JOIN kb_merchants m ON m.id = p.merchant_id AND m.status IN ('candidate', 'verified')
  LEFT JOIN kb_merchant_links ml ON ml.kb_merchant_id = m.id
  WHERE l.status = 'published' AND (l.platform_product_id IS NOT NULL OR m.id IS NOT NULL);

-- Merchant -> its listed products and the foods they are linked to.
CREATE VIEW IF NOT EXISTS kb_v_merchant_foods AS
  SELECT m.id AS kb_merchant_id, m.name AS merchant_name, p.id AS kb_product_id, p.original_name AS product_name,
         p.availability, f.id AS food_entity_id, f.key AS food_key, f.canonical_name AS food_name, l.match_type, l.link_role
  FROM kb_merchants m
  JOIN kb_merchant_products p ON p.merchant_id = m.id AND p.status = 'published'
  LEFT JOIN kb_food_product_links l ON l.kb_product_id = p.id AND l.status = 'published'
  LEFT JOIN kb_food_entities f ON f.id = l.food_entity_id AND f.status = 'published'
  WHERE m.status IN ('candidate', 'verified');

-- "Nhiều món / menu đa dạng": counts from published listings, with how fresh they are.
CREATE VIEW IF NOT EXISTS kb_v_merchant_menu_stats AS
  SELECT m.id AS kb_merchant_id, m.name AS merchant_name,
         COUNT(DISTINCT CASE WHEN p.availability != 'inactive' THEN p.id END) AS product_count,
         COUNT(DISTINCT l.food_entity_id) AS food_count,
         COUNT(DISTINCT c.name) AS category_count,
         MAX(p.last_seen_at) AS menu_last_seen_at
  FROM kb_merchants m
  LEFT JOIN kb_merchant_products p ON p.merchant_id = m.id AND p.status = 'published'
  LEFT JOIN kb_menu_categories c ON c.id = p.category_id
  LEFT JOIN kb_food_product_links l ON l.kb_product_id = p.id AND l.status = 'published'
  WHERE m.status IN ('candidate', 'verified')
  GROUP BY m.id;

-- Latest published price per product and variant — "latest seen", not "current".
CREATE VIEW IF NOT EXISTS kb_v_latest_prices AS
  SELECT pp.* FROM kb_product_prices pp
  WHERE pp.status = 'published'
    AND pp.captured_at = (SELECT MAX(x.captured_at) FROM kb_product_prices x
                          WHERE x.product_id = pp.product_id AND x.variant IS pp.variant AND x.status = 'published');

-- Latest published rating per merchant AND rating source (sources are never merged).
CREATE VIEW IF NOT EXISTS kb_v_latest_ratings AS
  SELECT r.* FROM kb_merchant_ratings r
  WHERE r.status = 'published'
    AND r.captured_at = (SELECT MAX(x.captured_at) FROM kb_merchant_ratings x
                         WHERE x.merchant_id = r.merchant_id AND x.rating_source = r.rating_source AND x.status = 'published');
