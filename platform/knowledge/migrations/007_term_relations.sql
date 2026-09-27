-- Dish name / keyword relations (term rule engine). CANONICAL FOOD -> APPROVED TERMS -> DETERMINISTIC MATCHING.
--
-- A relation says how a term relates to a canonical dish (kb_food_entities, read only here):
--   EXACT_ALIAS / SPELLING_VARIANT / DIACRITIC_VARIANT / COMMON_QUERY / ABBREVIATION  -> the term NAMES the dish
--   REGIONAL_ALIAS   -> how a region calls the dish (region_id); it names the dish, with that region noted
--   RELATED_TERM     -> related (an ingredient, a method, a sibling dish) — NEVER resolves to the dish
--   DISALLOWED_TERM  -> the term must NOT resolve to the dish (food_entity_id NULL = to no dish at all)
-- Lifecycle DRAFT -> REVIEW -> APPROVED -> RETIRED (REVIEW may go back to DRAFT). Only APPROVED is used by the
-- matcher. A customer message never creates a relation; an LLM may only PROPOSE; approval is a person's act.
-- An APPROVED version is immutable (a change is a new version); nothing is deleted; every step is recorded.
-- This layer never writes kb_food_entities / kb_food_names or anything else of Food Knowledge.

CREATE TABLE IF NOT EXISTS kb_term_relations (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  lineage_id      INTEGER,
  version         INTEGER NOT NULL DEFAULT 1,
  supersedes_id   INTEGER REFERENCES kb_term_relations(id),
  food_entity_id  INTEGER REFERENCES kb_food_entities(id),
  canonical_name  TEXT,                                    -- the dish's canonical name when proposed (snapshot)
  term            TEXT NOT NULL CHECK (length(trim(term)) > 0),
  term_key        TEXT NOT NULL,                           -- accent-free, lower-case, punctuation-free form
  term_accented   INTEGER NOT NULL DEFAULT 0,              -- the term was written with Vietnamese diacritics
  relation_type   TEXT NOT NULL CHECK (relation_type IN ('EXACT_ALIAS', 'SPELLING_VARIANT', 'DIACRITIC_VARIANT', 'COMMON_QUERY', 'ABBREVIATION', 'REGIONAL_ALIAS', 'RELATED_TERM', 'DISALLOWED_TERM')),
  region_id       TEXT REFERENCES kb_regions(id),         -- REGIONAL_ALIAS only: where the dish is called this way
  confidence      REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  status          TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'REVIEW', 'APPROVED', 'RETIRED')),
  proposed_by_kind TEXT NOT NULL CHECK (proposed_by_kind IN ('person', 'llm', 'rule', 'import')),
  created_by      TEXT NOT NULL,
  approved_by     TEXT,
  approved_at     TEXT,
  retired_by      TEXT,
  retired_at      TEXT,
  retired_reason  TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (food_entity_id IS NOT NULL OR relation_type = 'DISALLOWED_TERM'),
  CHECK ((relation_type = 'REGIONAL_ALIAS') = (region_id IS NOT NULL)),
  CHECK (status != 'APPROVED' OR (approved_by IS NOT NULL AND approved_at IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_kb_term_relations_one_approved ON kb_term_relations(lineage_id) WHERE status = 'APPROVED';
CREATE UNIQUE INDEX IF NOT EXISTS idx_kb_term_relations_version ON kb_term_relations(lineage_id, version);
-- the same term/dish/type is approved at most once
CREATE UNIQUE INDEX IF NOT EXISTS idx_kb_term_relations_approved_term ON kb_term_relations(term_key, IFNULL(food_entity_id, 0), relation_type, IFNULL(region_id, '')) WHERE status = 'APPROVED';
CREATE INDEX IF NOT EXISTS idx_kb_term_relations_status ON kb_term_relations(status, term_key);

CREATE TRIGGER IF NOT EXISTS kb_term_relations_approved_immutable BEFORE UPDATE ON kb_term_relations
WHEN OLD.status = 'APPROVED' AND NOT (
  NEW.status = 'RETIRED'
  AND NEW.lineage_id IS OLD.lineage_id AND NEW.version = OLD.version AND NEW.supersedes_id IS OLD.supersedes_id
  AND NEW.food_entity_id IS OLD.food_entity_id AND NEW.canonical_name IS OLD.canonical_name
  AND NEW.term = OLD.term AND NEW.term_key = OLD.term_key AND NEW.term_accented = OLD.term_accented
  AND NEW.relation_type = OLD.relation_type AND NEW.region_id IS OLD.region_id AND NEW.confidence = OLD.confidence
  AND NEW.proposed_by_kind = OLD.proposed_by_kind AND NEW.created_by = OLD.created_by
  AND NEW.approved_by = OLD.approved_by AND NEW.approved_at = OLD.approved_at AND NEW.created_at = OLD.created_at
)
BEGIN SELECT RAISE(ABORT, 'an APPROVED term relation is immutable: create a new version'); END;
CREATE TRIGGER IF NOT EXISTS kb_term_relations_retired_immutable BEFORE UPDATE ON kb_term_relations
WHEN OLD.status = 'RETIRED'
BEGIN SELECT RAISE(ABORT, 'a RETIRED term relation is immutable'); END;
CREATE TRIGGER IF NOT EXISTS kb_term_relations_no_delete BEFORE DELETE ON kb_term_relations
BEGIN SELECT RAISE(ABORT, 'term relations are never deleted (retire them)'); END;

-- provenance: where a relation came from — a founder item, a Food Knowledge evidence row, a raw text, an ingestion message
CREATE TABLE IF NOT EXISTS kb_term_evidence (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  relation_id INTEGER NOT NULL REFERENCES kb_term_relations(id),
  source_kind TEXT NOT NULL CHECK (source_kind IN ('founder_item', 'kb_evidence', 'ingest_message', 'text')),
  source_ref  TEXT NOT NULL,                                -- id of that row, or a sha256 for a raw text
  quote       TEXT NOT NULL CHECK (length(trim(quote)) > 0),
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_kb_term_evidence_relation ON kb_term_evidence(relation_id);
CREATE TRIGGER IF NOT EXISTS kb_term_evidence_no_update BEFORE UPDATE ON kb_term_evidence
BEGIN SELECT RAISE(ABORT, 'kb_term_evidence is append-only'); END;
CREATE TRIGGER IF NOT EXISTS kb_term_evidence_no_delete BEFORE DELETE ON kb_term_evidence
BEGIN SELECT RAISE(ABORT, 'kb_term_evidence is append-only'); END;

CREATE TABLE IF NOT EXISTS kb_term_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  relation_id INTEGER NOT NULL REFERENCES kb_term_relations(id),
  action      TEXT NOT NULL CHECK (action IN ('proposed', 'submitted', 'returned', 'approved', 'retired', 'evidence_linked')),
  actor       TEXT NOT NULL,
  note        TEXT,
  at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TRIGGER IF NOT EXISTS kb_term_events_no_update BEFORE UPDATE ON kb_term_events
BEGIN SELECT RAISE(ABORT, 'kb_term_events is append-only'); END;
CREATE TRIGGER IF NOT EXISTS kb_term_events_no_delete BEFORE DELETE ON kb_term_events
BEGIN SELECT RAISE(ABORT, 'kb_term_events is append-only'); END;
