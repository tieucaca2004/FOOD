-- Coverage expansion (Nha Trang food knowledge).
--
-- 1. Region names: a region can be written several ways ("Sài Gòn" /
--    "Thành phố Hồ Chí Minh", "Nam Vang" / "Phnom Penh"). Used for a food's
--    STYLE / ORIGIN (relations regional_style, origin_region) — never for
--    where a merchant is (that is kb_merchant_locations).
CREATE TABLE IF NOT EXISTS kb_region_names (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  region_id   TEXT NOT NULL REFERENCES kb_regions(id),
  name        TEXT NOT NULL,
  normalized  TEXT NOT NULL,
  UNIQUE (region_id, normalized)
);
CREATE INDEX IF NOT EXISTS idx_kb_region_names_normalized ON kb_region_names(normalized);

-- 2. Food duplicate / variant candidates. Two food entities whose names
--    overlap ("Nem nướng" / "Nem nướng Nha Trang", "Bún bò" / "Bún bò Huế",
--    "Hủ tiếu" / "Hủ tiếu Nam Vang") are NEVER merged automatically: the
--    pair is recorded here and a person decides (same dish, a variant, or
--    distinct dishes).
CREATE TABLE IF NOT EXISTS kb_food_duplicate_candidates (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_a     INTEGER NOT NULL REFERENCES kb_food_entities(id),
  entity_b     INTEGER NOT NULL REFERENCES kb_food_entities(id),
  kind         TEXT NOT NULL CHECK (kind IN ('same_name', 'shared_name', 'name_extends', 'regional_style_of')),
  signals_json TEXT NOT NULL,                -- which names overlapped, how
  score        REAL,
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'same_dish', 'variant', 'distinct')),
  decided_by   TEXT,
  decided_at   TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (entity_a < entity_b),
  CHECK (status = 'pending' OR decided_by IS NOT NULL),
  UNIQUE (entity_a, entity_b)
);
CREATE INDEX IF NOT EXISTS idx_kb_food_dups_status ON kb_food_duplicate_candidates(status);

-- 3. How a merchant product was observed: on the merchant's own menu, or
--    only MENTIONED by a third-party article ("quán nổi tiếng với bún cá").
--    A mention is evidence the place serves the dish — not a menu listing,
--    not a price.
ALTER TABLE kb_merchant_products ADD COLUMN observation TEXT NOT NULL DEFAULT 'menu' CHECK (observation IN ('menu', 'mention'));
