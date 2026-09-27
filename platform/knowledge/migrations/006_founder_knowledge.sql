-- Founder / Business Knowledge (FK-1): what the founder teaches FOOD about how to advise customers —
-- policies, advice style, FAQ, FOOD's own recommendations, internal notes.
--
-- It is NOT a fact store. It never states, and never overrides, a price, what is on sale, what can be
-- ordered, an address, opening hours or an order's state: those stay with the platform catalog and the
-- Food Knowledge facts (kb_* above), which this layer never writes.
--
-- Lifecycle: DRAFT -> REVIEW -> APPROVED -> RETIRED (REVIEW may go back to DRAFT). Only APPROVED, inside its
-- validity window, is in force. An APPROVED version is immutable (triggers): a change is a NEW version that
-- supersedes it; approving the new version retires the old one. One APPROVED version per lineage (index).
-- Nothing is ever deleted; every transition is recorded in kb_founder_events.
--
-- Provenance: every item links evidence — a verbatim quote from a source (a raw text file with its sha256,
-- a Knowledge Ingestion message, later a document or image) — so it can always be traced to where it came from.

CREATE TABLE IF NOT EXISTS kb_founder_sources (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  kind              TEXT NOT NULL CHECK (kind IN ('text', 'ingest_message', 'document', 'image')),
  raw_path          TEXT,                                  -- immutable raw copy (text / document / image)
  sha256            TEXT,
  ingest_message_id INTEGER REFERENCES kb_ingest_messages(id), -- when it came through Knowledge Ingestion
  submitted_by      TEXT NOT NULL,
  received_at       TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (raw_path IS NOT NULL OR ingest_message_id IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_kb_founder_sources_sha ON kb_founder_sources(sha256) WHERE sha256 IS NOT NULL;
CREATE TRIGGER IF NOT EXISTS kb_founder_sources_no_update BEFORE UPDATE ON kb_founder_sources
BEGIN SELECT RAISE(ABORT, 'kb_founder_sources is append-only'); END;
CREATE TRIGGER IF NOT EXISTS kb_founder_sources_no_delete BEFORE DELETE ON kb_founder_sources
BEGIN SELECT RAISE(ABORT, 'kb_founder_sources is append-only'); END;

CREATE TABLE IF NOT EXISTS kb_founder_items (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  lineage_id    INTEGER,                                  -- the first version's id (all versions share it)
  version       INTEGER NOT NULL DEFAULT 1,
  supersedes_id INTEGER REFERENCES kb_founder_items(id),
  type          TEXT NOT NULL CHECK (type IN ('POLICY', 'ADVICE_STYLE', 'FAQ', 'FOOD_RECOMMENDATION', 'INTERNAL_NOTE')),
  title         TEXT NOT NULL CHECK (length(trim(title)) > 0),
  body          TEXT NOT NULL CHECK (length(trim(body)) > 0),
  scope         TEXT NOT NULL CHECK (scope IN ('global', 'region', 'merchant', 'product')),
  scope_ref     TEXT,                                     -- region id / "cat:<id>" or "kb:<id>" place / product ref
  audience      TEXT NOT NULL CHECK (audience IN ('customer', 'internal')),
  priority      INTEGER NOT NULL DEFAULT 50 CHECK (priority BETWEEN 0 AND 100),
  status        TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'REVIEW', 'APPROVED', 'RETIRED')),
  warnings_json TEXT NOT NULL DEFAULT '[]',                -- text that looks like an authoritative fact (price, hours…)
  author        TEXT NOT NULL,
  approved_by   TEXT,
  approved_at   TEXT,
  retired_by    TEXT,
  retired_at    TEXT,
  retired_reason TEXT,
  valid_from    TEXT,
  valid_to      TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK ((scope = 'global') = (scope_ref IS NULL)),
  CHECK (type != 'INTERNAL_NOTE' OR audience = 'internal'),  -- an internal note is never customer-facing
  CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_to > valid_from),
  CHECK (status != 'APPROVED' OR (approved_by IS NOT NULL AND approved_at IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_kb_founder_items_one_approved ON kb_founder_items(lineage_id) WHERE status = 'APPROVED';
CREATE UNIQUE INDEX IF NOT EXISTS idx_kb_founder_items_version ON kb_founder_items(lineage_id, version);
CREATE INDEX IF NOT EXISTS idx_kb_founder_items_active ON kb_founder_items(status, audience, scope, scope_ref);

-- An APPROVED version never changes, except to be RETIRED; a RETIRED one never changes at all.
CREATE TRIGGER IF NOT EXISTS kb_founder_items_approved_immutable BEFORE UPDATE ON kb_founder_items
WHEN OLD.status = 'APPROVED' AND NOT (
  NEW.status = 'RETIRED'
  AND NEW.lineage_id IS OLD.lineage_id AND NEW.version = OLD.version AND NEW.supersedes_id IS OLD.supersedes_id
  AND NEW.type = OLD.type AND NEW.title = OLD.title AND NEW.body = OLD.body
  AND NEW.scope = OLD.scope AND NEW.scope_ref IS OLD.scope_ref AND NEW.audience = OLD.audience
  AND NEW.priority = OLD.priority AND NEW.warnings_json = OLD.warnings_json AND NEW.author = OLD.author
  AND NEW.approved_by = OLD.approved_by AND NEW.approved_at = OLD.approved_at
  AND NEW.valid_from IS OLD.valid_from AND NEW.valid_to IS OLD.valid_to AND NEW.created_at = OLD.created_at
)
BEGIN SELECT RAISE(ABORT, 'an APPROVED founder knowledge version is immutable: create a new version'); END;
CREATE TRIGGER IF NOT EXISTS kb_founder_items_retired_immutable BEFORE UPDATE ON kb_founder_items
WHEN OLD.status = 'RETIRED'
BEGIN SELECT RAISE(ABORT, 'a RETIRED founder knowledge version is immutable'); END;
CREATE TRIGGER IF NOT EXISTS kb_founder_items_no_delete BEFORE DELETE ON kb_founder_items
BEGIN SELECT RAISE(ABORT, 'founder knowledge is never deleted (retire it)'); END;

CREATE TABLE IF NOT EXISTS kb_founder_evidence (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id    INTEGER NOT NULL REFERENCES kb_founder_items(id),
  source_id  INTEGER NOT NULL REFERENCES kb_founder_sources(id),
  quote      TEXT NOT NULL CHECK (length(trim(quote)) > 0),   -- verbatim from the source
  locator    TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_kb_founder_evidence_item ON kb_founder_evidence(item_id);
CREATE TRIGGER IF NOT EXISTS kb_founder_evidence_no_update BEFORE UPDATE ON kb_founder_evidence
BEGIN SELECT RAISE(ABORT, 'kb_founder_evidence is append-only'); END;
CREATE TRIGGER IF NOT EXISTS kb_founder_evidence_no_delete BEFORE DELETE ON kb_founder_evidence
BEGIN SELECT RAISE(ABORT, 'kb_founder_evidence is append-only'); END;

-- the audit trail: who did what to which version, when
CREATE TABLE IF NOT EXISTS kb_founder_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id    INTEGER NOT NULL REFERENCES kb_founder_items(id),
  action     TEXT NOT NULL CHECK (action IN ('created', 'edited', 'submitted', 'returned', 'approved', 'retired', 'evidence_linked')),
  actor      TEXT NOT NULL,
  note       TEXT,
  at         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TRIGGER IF NOT EXISTS kb_founder_events_no_update BEFORE UPDATE ON kb_founder_events
BEGIN SELECT RAISE(ABORT, 'kb_founder_events is append-only'); END;
CREATE TRIGGER IF NOT EXISTS kb_founder_events_no_delete BEFORE DELETE ON kb_founder_events
BEGIN SELECT RAISE(ABORT, 'kb_founder_events is append-only'); END;
