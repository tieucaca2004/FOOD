-- Knowledge Ingestion (Knowledge Group -> evidence -> candidates -> review).
--
-- RAW EVIDENCE != KNOWLEDGE FACT. Nothing here is published knowledge:
--   kb_ingest_messages / kb_ingest_media / kb_ingest_message_media / kb_ingest_extractions
--     are append-only records of what was received and what a reader (rule, OCR, vision, LLM)
--     made of it — triggers forbid UPDATE and DELETE, so evidence can never be rewritten;
--   kb_ingest_candidates are PROPOSALS (NEW / UPDATED / CONFLICT / ...) waiting for a decision;
--     only an approved candidate may later go through the existing evidence-gated store
--     (kb_merchant_products / kb_product_prices / kb_merchant_locations / kb_merchant_claims),
--     whose history (captured_at rows) is never overwritten;
--   kb_ingest_jobs track processing (OCR / vision may be slow, fail and be retried);
--   kb_ingest_contributors say who may contribute and with which role — never "verified source".
-- The message text is also stored as a raw file registered in kb_sources (source_type
-- knowledge_group), so every candidate quote is checked against the original like any source.

CREATE TABLE IF NOT EXISTS kb_ingest_contributors (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  channel          TEXT NOT NULL,
  external_user_id TEXT NOT NULL,
  role             TEXT NOT NULL CHECK (role IN ('admin', 'editor', 'verified', 'member', 'blocked')),
  added_by         TEXT NOT NULL,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (channel, external_user_id)
);

CREATE TABLE IF NOT EXISTS kb_ingest_messages (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  channel             TEXT NOT NULL,
  chat_id             TEXT NOT NULL,
  message_id          TEXT NOT NULL,
  update_id           TEXT,
  sender_id           TEXT,
  sender_display_name TEXT,
  sender_role         TEXT NOT NULL,          -- the role at the time of sending (history, not the current role)
  sent_at             TEXT,
  text                TEXT,                   -- verbatim
  caption             TEXT,                   -- verbatim
  reply_to_message_id TEXT,
  media_group_id      TEXT,
  raw_update_json     TEXT NOT NULL,          -- the update exactly as received
  source_id           INTEGER REFERENCES kb_sources(id),  -- raw text snapshot (NULL for a media-only message)
  received_at         TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (channel, chat_id, message_id)       -- a redelivered update is the same message
);
CREATE TRIGGER IF NOT EXISTS kb_ingest_messages_no_update BEFORE UPDATE ON kb_ingest_messages
BEGIN SELECT RAISE(ABORT, 'kb_ingest_messages is append-only'); END;
CREATE TRIGGER IF NOT EXISTS kb_ingest_messages_no_delete BEFORE DELETE ON kb_ingest_messages
BEGIN SELECT RAISE(ABORT, 'kb_ingest_messages is append-only'); END;

CREATE TABLE IF NOT EXISTS kb_ingest_media (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  sha256            TEXT NOT NULL UNIQUE,     -- the same image sent twice is one stored file
  mime_type         TEXT,
  size_bytes        INTEGER NOT NULL,
  storage_ref       TEXT NOT NULL,            -- content-addressed path under the raw root
  original_filename TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TRIGGER IF NOT EXISTS kb_ingest_media_no_update BEFORE UPDATE ON kb_ingest_media
BEGIN SELECT RAISE(ABORT, 'kb_ingest_media is append-only'); END;
CREATE TRIGGER IF NOT EXISTS kb_ingest_media_no_delete BEFORE DELETE ON kb_ingest_media
BEGIN SELECT RAISE(ABORT, 'kb_ingest_media is append-only'); END;

-- which media a message carried (file_id is the channel's handle, valid only for fetching)
CREATE TABLE IF NOT EXISTS kb_ingest_message_media (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id       INTEGER NOT NULL REFERENCES kb_ingest_messages(id),
  position         INTEGER NOT NULL,
  media_type       TEXT NOT NULL,             -- photo | document
  external_file_id TEXT NOT NULL,
  mime_type        TEXT,
  original_filename TEXT,
  UNIQUE (message_id, position)
);
CREATE TRIGGER IF NOT EXISTS kb_ingest_message_media_no_update BEFORE UPDATE ON kb_ingest_message_media
BEGIN SELECT RAISE(ABORT, 'kb_ingest_message_media is append-only'); END;
CREATE TRIGGER IF NOT EXISTS kb_ingest_message_media_no_delete BEFORE DELETE ON kb_ingest_message_media
BEGIN SELECT RAISE(ABORT, 'kb_ingest_message_media is append-only'); END;

-- the stored file a message's medium turned out to be, once fetched (the same image twice -> one media row)
CREATE TABLE IF NOT EXISTS kb_ingest_fetched (
  message_media_id INTEGER PRIMARY KEY REFERENCES kb_ingest_message_media(id),
  media_id         INTEGER NOT NULL REFERENCES kb_ingest_media(id),
  duplicate_of_earlier INTEGER NOT NULL DEFAULT 0,  -- 1 = this exact file had been received before
  fetched_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TRIGGER IF NOT EXISTS kb_ingest_fetched_no_update BEFORE UPDATE ON kb_ingest_fetched
BEGIN SELECT RAISE(ABORT, 'kb_ingest_fetched is append-only'); END;
CREATE TRIGGER IF NOT EXISTS kb_ingest_fetched_no_delete BEFORE DELETE ON kb_ingest_fetched
BEGIN SELECT RAISE(ABORT, 'kb_ingest_fetched is append-only'); END;

CREATE TABLE IF NOT EXISTS kb_ingest_jobs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id      INTEGER NOT NULL REFERENCES kb_ingest_messages(id),
  stage           TEXT NOT NULL CHECK (stage IN ('text', 'media_fetch', 'ocr', 'vision', 'fusion')),
  item            INTEGER NOT NULL DEFAULT 0, -- kb_ingest_message_media.id for media stages, 0 otherwise
  status          TEXT NOT NULL CHECK (status IN ('RECEIVED', 'PROCESSING', 'EXTRACTED', 'REVIEW', 'WAITING_PROVIDER', 'DONE', 'FAILED')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  next_attempt_at TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (message_id, stage, item)
);
CREATE INDEX IF NOT EXISTS idx_kb_ingest_jobs_status ON kb_ingest_jobs(status, next_attempt_at);

-- what a reader made of a message or a medium: every attempt is kept (a retry adds a row)
CREATE TABLE IF NOT EXISTS kb_ingest_extractions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id  INTEGER NOT NULL REFERENCES kb_ingest_messages(id),
  media_id    INTEGER REFERENCES kb_ingest_media(id),
  kind        TEXT NOT NULL CHECK (kind IN ('text_rule', 'text_llm', 'ocr', 'vision', 'fusion')),
  provider    TEXT NOT NULL,
  model       TEXT,
  output_json TEXT NOT NULL,                  -- OCR blocks / vision observations vs inferences / rule findings
  confidence  REAL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TRIGGER IF NOT EXISTS kb_ingest_extractions_no_update BEFORE UPDATE ON kb_ingest_extractions
BEGIN SELECT RAISE(ABORT, 'kb_ingest_extractions is append-only'); END;
CREATE TRIGGER IF NOT EXISTS kb_ingest_extractions_no_delete BEFORE DELETE ON kb_ingest_extractions
BEGIN SELECT RAISE(ABORT, 'kb_ingest_extractions is append-only'); END;

CREATE TABLE IF NOT EXISTS kb_ingest_candidates (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id        INTEGER NOT NULL REFERENCES kb_ingest_messages(id),
  extraction_id     INTEGER REFERENCES kb_ingest_extractions(id),
  kind              TEXT NOT NULL CHECK (kind IN ('price', 'product', 'address', 'opening_hours', 'availability', 'place', 'food')),
  place_text        TEXT,                     -- the place as written
  place_resolution  TEXT NOT NULL,            -- JSON {status: resolved|ambiguous|unknown, kbPlaceId, candidates[]}
  product_text      TEXT,
  kb_product_id     INTEGER,
  field             TEXT NOT NULL,
  raw_value         TEXT,                     -- as written ("45k")
  normalized_value  TEXT,                     -- as understood ("45000")
  previous_value    TEXT,                     -- what published knowledge says now (NULL if nothing)
  change            TEXT NOT NULL CHECK (change IN ('NEW', 'UPDATED', 'UNCHANGED', 'REMOVED', 'CONFLICT', 'DUPLICATE', 'UNCERTAIN')),
  severity          TEXT NOT NULL CHECK (severity IN ('LOW', 'MEDIUM', 'HIGH')),
  confidence        REAL NOT NULL,
  evidence_quote    TEXT NOT NULL,            -- verbatim from the raw source below
  source_id         INTEGER REFERENCES kb_sources(id),
  status            TEXT NOT NULL DEFAULT 'review' CHECK (status IN ('review', 'approved', 'rejected', 'applied')),
  decided_by        TEXT,
  decided_at        TEXT,
  decision_note     TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
-- re-processing a message adds nothing (IFNULL: SQLite treats NULLs in a UNIQUE constraint as distinct)
CREATE UNIQUE INDEX IF NOT EXISTS idx_kb_ingest_candidates_once
  ON kb_ingest_candidates(message_id, kind, field, IFNULL(place_text, ''), IFNULL(product_text, ''), IFNULL(raw_value, ''));
CREATE INDEX IF NOT EXISTS idx_kb_ingest_candidates_status ON kb_ingest_candidates(status, change);
