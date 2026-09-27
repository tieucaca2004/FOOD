-- Customer contributions (Multimodal Knowledge Ingestion V1) on top of 005.
--
-- Additive only: new tables, new nullable / defaulted columns, triggers, indexes, one view. No 005 table is
-- rebuilt and no 005 CHECK changes; the Knowledge Group path writes exactly what it wrote before.
--
--   kb_ingest_submissions          one customer contribution = the pending state machine (mutable, guarded).
--                                  The pending state lives HERE — never in the platform session / ordering state.
--   kb_ingest_submission_events    every transition (append-only)
--   kb_ingest_messages       +     source_type, submission_id, sender_hash, sender_hash_kid
--   kb_ingest_candidates     +     provenance (assertion_kind, message_media_id, place_message_id, variant,
--                                  food_entity_id, catalog_merchant_id), reviewer links / flag,
--                                  resolved_kb_merchant_id (virtual)
--   kb_ingest_applications         approved candidate -> the published kb_* row it became (append-only)
--   kb_ingest_purges               retention / erasure: file deleted, hash row kept (append-only)
--   kb_contribution_visible        the eligibility rule for showing a candidate as
--                                  USER_CONTRIBUTED_UNVERIFIED_EVIDENCE (expiry is applied at read time)
--
-- Customer identity: a keyed hash only ('h1:' + HMAC-SHA256, key outside the DB). A customer's words live only in
-- the raw source file (kb_sources) so they can be erased; the append-only message row never holds them.

-- ------------------------------------------------------------------ submissions (pending state lives here)

CREATE TABLE IF NOT EXISTS kb_ingest_submissions (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  channel           TEXT NOT NULL CHECK (channel IN ('telegram', 'zalo')),
  sender_hash       TEXT NOT NULL CHECK (sender_hash LIKE 'h1:%'),
  sender_hash_kid   TEXT NOT NULL,
  session_ref       TEXT,                     -- the platform session id (a pointer, no identity)
  status            TEXT NOT NULL DEFAULT 'RECEIVED' CHECK (status IN (
                      'RECEIVED', 'EXTRACTING', 'WAITING_FOR_MERCHANT', 'WAITING_FOR_CONFIRMATION',
                      'CANDIDATE', 'CLOSED', 'CANCELLED', 'EXPIRED', 'FAILED', 'NO_CONTENT')),
  place_text        TEXT,                     -- the place as the customer wrote it (verbatim, from place_message_id)
  place_resolution  TEXT,                     -- JSON {status, class, kbPlaceId, catalogMerchantId, candidates[]}
  place_message_id  INTEGER REFERENCES kb_ingest_messages(id),
  questions_asked   INTEGER NOT NULL DEFAULT 0 CHECK (questions_asked BETWEEN 0 AND 3),
  expires_at        TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
  confirmed_at      TEXT,
  closed_at         TEXT,
  CHECK (status NOT IN ('WAITING_FOR_MERCHANT', 'WAITING_FOR_CONFIRMATION') OR expires_at IS NOT NULL)
);
-- at most ONE open submission per person per channel (the next image / reply joins it)
CREATE UNIQUE INDEX IF NOT EXISTS idx_kb_ingest_submissions_open
  ON kb_ingest_submissions(channel, sender_hash)
  WHERE status IN ('RECEIVED', 'EXTRACTING', 'WAITING_FOR_MERCHANT', 'WAITING_FOR_CONFIRMATION');
CREATE INDEX IF NOT EXISTS idx_kb_ingest_submissions_status ON kb_ingest_submissions(status, expires_at);

-- identity and history never change; the place may change only while the submission is still open
CREATE TRIGGER IF NOT EXISTS kb_ingest_submissions_guard BEFORE UPDATE ON kb_ingest_submissions
WHEN NEW.channel IS NOT OLD.channel OR NEW.sender_hash IS NOT OLD.sender_hash OR NEW.sender_hash_kid IS NOT OLD.sender_hash_kid
  OR NEW.created_at IS NOT OLD.created_at OR NEW.session_ref IS NOT OLD.session_ref
  OR ((NEW.place_text IS NOT OLD.place_text OR NEW.place_message_id IS NOT OLD.place_message_id OR NEW.place_resolution IS NOT OLD.place_resolution)
      AND OLD.status NOT IN ('RECEIVED', 'EXTRACTING', 'WAITING_FOR_MERCHANT', 'WAITING_FOR_CONFIRMATION'))
BEGIN SELECT RAISE(ABORT, 'kb_ingest_submissions identity is immutable'); END;

-- deterministic state machine
CREATE TRIGGER IF NOT EXISTS kb_ingest_submissions_transition BEFORE UPDATE OF status ON kb_ingest_submissions
WHEN NEW.status IS NOT OLD.status AND NOT (
     (OLD.status = 'RECEIVED'                 AND NEW.status IN ('EXTRACTING', 'CANCELLED', 'FAILED'))
  OR (OLD.status = 'EXTRACTING'               AND NEW.status IN ('WAITING_FOR_MERCHANT', 'WAITING_FOR_CONFIRMATION', 'CANDIDATE', 'NO_CONTENT', 'FAILED', 'CANCELLED'))
  OR (OLD.status = 'WAITING_FOR_MERCHANT'     AND NEW.status IN ('EXTRACTING', 'WAITING_FOR_CONFIRMATION', 'CANDIDATE', 'CANCELLED', 'EXPIRED'))
  OR (OLD.status = 'WAITING_FOR_CONFIRMATION' AND NEW.status IN ('EXTRACTING', 'WAITING_FOR_MERCHANT', 'CANDIDATE', 'CANCELLED', 'EXPIRED'))
  OR (OLD.status = 'CANDIDATE'                AND NEW.status IN ('CLOSED'))
)
BEGIN SELECT RAISE(ABORT, 'kb_ingest_submissions: transition not allowed'); END;

CREATE TABLE IF NOT EXISTS kb_ingest_submission_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  submission_id INTEGER NOT NULL REFERENCES kb_ingest_submissions(id),
  from_status   TEXT,
  to_status     TEXT NOT NULL,
  message_id    INTEGER REFERENCES kb_ingest_messages(id),  -- the message that caused it (NULL: timer / reviewer)
  actor         TEXT NOT NULL CHECK (actor IN ('customer', 'system') OR actor LIKE 'reviewer:%'),
  reason        TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_kb_ingest_submission_events ON kb_ingest_submission_events(submission_id, id);
CREATE TRIGGER IF NOT EXISTS kb_ingest_submission_events_no_update BEFORE UPDATE ON kb_ingest_submission_events
BEGIN SELECT RAISE(ABORT, 'kb_ingest_submission_events is append-only'); END;
CREATE TRIGGER IF NOT EXISTS kb_ingest_submission_events_no_delete BEFORE DELETE ON kb_ingest_submission_events
BEGIN SELECT RAISE(ABORT, 'kb_ingest_submission_events is append-only'); END;

-- ------------------------------------------------------------------ messages: customer provenance, no raw identity

ALTER TABLE kb_ingest_messages ADD COLUMN source_type TEXT NOT NULL DEFAULT 'knowledge_group'
  CHECK (source_type IN ('knowledge_group', 'user_contribution'));
ALTER TABLE kb_ingest_messages ADD COLUMN submission_id INTEGER REFERENCES kb_ingest_submissions(id);
ALTER TABLE kb_ingest_messages ADD COLUMN sender_hash TEXT;
ALTER TABLE kb_ingest_messages ADD COLUMN sender_hash_kid TEXT;
CREATE INDEX IF NOT EXISTS idx_kb_ingest_messages_submission ON kb_ingest_messages(submission_id);
CREATE INDEX IF NOT EXISTS idx_kb_ingest_messages_sender ON kb_ingest_messages(source_type, sender_hash, received_at);

-- a customer's message never carries a raw platform id, a name, the sender object or its words
CREATE TRIGGER IF NOT EXISTS kb_ingest_messages_customer_privacy BEFORE INSERT ON kb_ingest_messages
WHEN NEW.source_type = 'user_contribution' AND (
     NEW.sender_id IS NOT NULL OR NEW.sender_display_name IS NOT NULL
  OR NEW.sender_hash IS NULL OR NEW.sender_hash NOT LIKE 'h1:%' OR NEW.sender_hash_kid IS NULL
  OR NEW.chat_id NOT LIKE 'h1:%' OR NEW.submission_id IS NULL
  OR NEW.text IS NOT NULL OR NEW.caption IS NOT NULL
  OR json_valid(NEW.raw_update_json) = 0
  OR json_type(NEW.raw_update_json, '$.message.from') IS NOT NULL
  OR json_type(NEW.raw_update_json, '$.message.chat') IS NOT NULL
  OR json_type(NEW.raw_update_json, '$.message.text') IS NOT NULL
  OR json_type(NEW.raw_update_json, '$.message.caption') IS NOT NULL
  OR json_type(NEW.raw_update_json, '$.sender') IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'customer contribution must be pseudonymous (sender_hash only; words only in the purgeable source file)'); END;

-- a Knowledge Group message is never attached to a customer submission
CREATE TRIGGER IF NOT EXISTS kb_ingest_messages_group_shape BEFORE INSERT ON kb_ingest_messages
WHEN NEW.source_type = 'knowledge_group' AND NEW.submission_id IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'knowledge_group messages have no submission'); END;

-- ------------------------------------------------------------------ candidates: provenance + review links

ALTER TABLE kb_ingest_candidates ADD COLUMN assertion_kind TEXT NOT NULL DEFAULT 'USER_ASSERTION'
  CHECK (assertion_kind IN ('OBSERVED', 'USER_ASSERTION', 'INFERRED'));
ALTER TABLE kb_ingest_candidates ADD COLUMN food_entity_id INTEGER REFERENCES kb_food_entities(id);
ALTER TABLE kb_ingest_candidates ADD COLUMN message_media_id INTEGER REFERENCES kb_ingest_message_media(id);
ALTER TABLE kb_ingest_candidates ADD COLUMN place_message_id INTEGER REFERENCES kb_ingest_messages(id);
ALTER TABLE kb_ingest_candidates ADD COLUMN variant TEXT;
ALTER TABLE kb_ingest_candidates ADD COLUMN catalog_merchant_id TEXT;   -- the FOOD catalog place it was compared with (authoritative)
ALTER TABLE kb_ingest_candidates ADD COLUMN review_kb_merchant_id INTEGER REFERENCES kb_merchants(id);
ALTER TABLE kb_ingest_candidates ADD COLUMN review_food_entity_id INTEGER REFERENCES kb_food_entities(id);
ALTER TABLE kb_ingest_candidates ADD COLUMN review_flag TEXT CHECK (review_flag IS NULL OR review_flag = 'CONFLICT');
ALTER TABLE kb_ingest_candidates ADD COLUMN resolved_kb_merchant_id INTEGER
  GENERATED ALWAYS AS (CASE WHEN json_extract(place_resolution, '$.status') = 'resolved' THEN json_extract(place_resolution, '$.kbPlaceId') END) VIRTUAL;

-- per-image and per-variant rows are distinct (the 005 key would merge two images / sizes of one message)
DROP INDEX IF EXISTS idx_kb_ingest_candidates_once;
CREATE UNIQUE INDEX IF NOT EXISTS idx_kb_ingest_candidates_once
  ON kb_ingest_candidates(message_id, kind, field, IFNULL(place_text, ''), IFNULL(product_text, ''), IFNULL(raw_value, ''),
                          IFNULL(variant, ''), IFNULL(message_media_id, 0), assertion_kind);
CREATE INDEX IF NOT EXISTS idx_kb_ingest_candidates_merchant ON kb_ingest_candidates(resolved_kb_merchant_id, field, status);
CREATE INDEX IF NOT EXISTS idx_kb_ingest_candidates_food ON kb_ingest_candidates(food_entity_id, status);

-- a customer candidate exists only for a CONFIRMED submission, and only with evidence
CREATE TRIGGER IF NOT EXISTS kb_ingest_candidates_customer_gate BEFORE INSERT ON kb_ingest_candidates
WHEN (SELECT source_type FROM kb_ingest_messages WHERE id = NEW.message_id) = 'user_contribution' AND (
     (SELECT s.status FROM kb_ingest_submissions s JOIN kb_ingest_messages m ON m.submission_id = s.id WHERE m.id = NEW.message_id) != 'CANDIDATE'
  OR length(trim(NEW.evidence_quote)) = 0
  OR (NEW.assertion_kind != 'INFERRED' AND NEW.source_id IS NULL)
  OR (NEW.assertion_kind = 'INFERRED' AND NOT (NEW.kind = 'food' AND NEW.field = 'dish')))
BEGIN SELECT RAISE(ABORT, 'customer candidate needs a confirmed submission and evidence'); END;

-- what the machine read is immutable; only the decision / review fields move, and only forward
CREATE TRIGGER IF NOT EXISTS kb_ingest_candidates_evidence_immutable BEFORE UPDATE ON kb_ingest_candidates
WHEN NEW.message_id IS NOT OLD.message_id OR NEW.extraction_id IS NOT OLD.extraction_id OR NEW.kind IS NOT OLD.kind
  OR NEW.place_text IS NOT OLD.place_text OR NEW.place_resolution IS NOT OLD.place_resolution
  OR NEW.product_text IS NOT OLD.product_text OR NEW.field IS NOT OLD.field
  OR NEW.raw_value IS NOT OLD.raw_value OR NEW.normalized_value IS NOT OLD.normalized_value
  OR NEW.previous_value IS NOT OLD.previous_value OR NEW.change IS NOT OLD.change
  OR NEW.confidence IS NOT OLD.confidence OR NEW.evidence_quote IS NOT OLD.evidence_quote
  OR NEW.source_id IS NOT OLD.source_id OR NEW.assertion_kind IS NOT OLD.assertion_kind
  OR NEW.message_media_id IS NOT OLD.message_media_id OR NEW.place_message_id IS NOT OLD.place_message_id
  OR NEW.variant IS NOT OLD.variant OR NEW.food_entity_id IS NOT OLD.food_entity_id
  OR NEW.catalog_merchant_id IS NOT OLD.catalog_merchant_id OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT, 'kb_ingest_candidates evidence is immutable'); END;

-- review links / flag only while the candidate is still in review
CREATE TRIGGER IF NOT EXISTS kb_ingest_candidates_review_links BEFORE UPDATE ON kb_ingest_candidates
WHEN (NEW.review_kb_merchant_id IS NOT OLD.review_kb_merchant_id OR NEW.review_food_entity_id IS NOT OLD.review_food_entity_id OR NEW.review_flag IS NOT OLD.review_flag)
  AND OLD.status != 'review'
BEGIN SELECT RAISE(ABORT, 'kb_ingest_candidates: review links change only in review'); END;

CREATE TRIGGER IF NOT EXISTS kb_ingest_candidates_decision BEFORE UPDATE OF status ON kb_ingest_candidates
WHEN NEW.status IS NOT OLD.status AND NOT (
     (OLD.status = 'review'   AND NEW.status IN ('approved', 'rejected') AND NEW.decided_by IS NOT NULL AND NEW.decided_by NOT LIKE 'system%')
  OR (OLD.status = 'review'   AND NEW.status = 'rejected' AND NEW.decided_by = 'system:contributor_request')
  OR (OLD.status = 'approved' AND NEW.status = 'applied'))
BEGIN SELECT RAISE(ABORT, 'kb_ingest_candidates: decision not allowed'); END;

-- ------------------------------------------------------------------ apply (approved -> published kb_* row)

CREATE TABLE IF NOT EXISTS kb_ingest_applications (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id  INTEGER NOT NULL UNIQUE REFERENCES kb_ingest_candidates(id),
  target_table  TEXT NOT NULL CHECK (target_table IN ('kb_merchants', 'kb_merchant_products', 'kb_product_prices', 'kb_merchant_locations', 'kb_merchant_claims')),
  target_id     INTEGER NOT NULL,
  evidence_id   INTEGER NOT NULL REFERENCES kb_evidence(id),
  applied_by    TEXT NOT NULL CHECK (applied_by NOT LIKE 'system%'),
  applied_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TRIGGER IF NOT EXISTS kb_ingest_applications_no_update BEFORE UPDATE ON kb_ingest_applications
BEGIN SELECT RAISE(ABORT, 'kb_ingest_applications is append-only'); END;
CREATE TRIGGER IF NOT EXISTS kb_ingest_applications_no_delete BEFORE DELETE ON kb_ingest_applications
BEGIN SELECT RAISE(ABORT, 'kb_ingest_applications is append-only'); END;
CREATE TRIGGER IF NOT EXISTS kb_ingest_applications_needs_approval BEFORE INSERT ON kb_ingest_applications
WHEN (SELECT status FROM kb_ingest_candidates WHERE id = NEW.candidate_id) != 'approved'
BEGIN SELECT RAISE(ABORT, 'only an approved candidate can be applied'); END;

-- ------------------------------------------------------------------ retention / erasure

CREATE TABLE IF NOT EXISTS kb_ingest_purges (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  target_kind TEXT NOT NULL CHECK (target_kind IN ('media', 'source')),  -- kb_ingest_media.id | kb_sources.id (text / OCR file)
  target_id   INTEGER NOT NULL,
  reason      TEXT NOT NULL CHECK (reason IN ('retention', 'contributor_request', 'unsafe_content', 'reviewer')),
  purged_by   TEXT NOT NULL,
  purged_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (target_kind, target_id)
);
CREATE TRIGGER IF NOT EXISTS kb_ingest_purges_no_update BEFORE UPDATE ON kb_ingest_purges
BEGIN SELECT RAISE(ABORT, 'kb_ingest_purges is append-only'); END;
CREATE TRIGGER IF NOT EXISTS kb_ingest_purges_no_delete BEFORE DELETE ON kb_ingest_purges
BEGIN SELECT RAISE(ABORT, 'kb_ingest_purges is append-only'); END;

-- ------------------------------------------------------------------ what may be shown as unverified evidence

-- eligible = in review, sender not blocked, customer submission confirmed; expiry (field TTL) is applied at read time
CREATE VIEW IF NOT EXISTS kb_contribution_visible AS
SELECT c.id AS candidate_id,
       'USER_CONTRIBUTED_UNVERIFIED_EVIDENCE' AS knowledge_kind,
       m.source_type,
       m.channel AS source_platform,
       CASE WHEN c.message_media_id IS NOT NULL OR EXISTS (SELECT 1 FROM kb_ingest_message_media mm WHERE mm.message_id = m.id)
            THEN CASE WHEN m.source_id IS NOT NULL THEN 'IMAGE_TEXT' ELSE 'IMAGE' END
            ELSE 'TEXT' END AS media_type,
       c.assertion_kind, c.kind, c.field,
       COALESCE(c.review_kb_merchant_id, c.resolved_kb_merchant_id) AS kb_merchant_id,
       c.catalog_merchant_id,
       c.kb_product_id,
       COALESCE(c.review_food_entity_id, c.food_entity_id) AS food_entity_id,
       c.place_text AS place_as_written, c.product_text AS name_as_written, c.variant,
       c.raw_value, c.normalized_value AS value, c.change, c.previous_value AS published_value, c.confidence,
       COALESCE(m.sent_at, m.received_at) AS captured_at,
       m.submission_id,
       m.sender_hash
FROM kb_ingest_candidates c
JOIN kb_ingest_messages m ON m.id = c.message_id
LEFT JOIN kb_ingest_submissions s ON s.id = m.submission_id
WHERE c.status = 'review'
  AND m.sender_role != 'blocked'
  AND NOT EXISTS (SELECT 1 FROM kb_ingest_contributors k
                  WHERE k.channel = m.channel AND k.role = 'blocked'
                    AND k.external_user_id = COALESCE(m.sender_hash, m.sender_id))
  AND (m.source_type = 'knowledge_group' OR s.status IN ('CANDIDATE', 'CLOSED'))
  AND c.change NOT IN ('UNCHANGED', 'DUPLICATE');
