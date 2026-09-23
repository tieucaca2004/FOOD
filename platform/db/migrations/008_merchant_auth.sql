-- Phase 7: minimal merchant authentication credential.
--
-- merchant_users (migration 001) has never been read from or written to
-- by any repository/service before now (confirmed by audit — zero
-- references anywhere in platform/). It has no rows in any real
-- deployment, so a plain ALTER TABLE ADD COLUMN is safe here — unlike
-- migrations 006/007, no rename/recreate rebuild is needed since we are
-- not adding a CHECK constraint or changing an existing column.
--
-- api_key_hash stores only the SHA-256 hash of a merchant's opaque,
-- randomly-generated API key (see platform/services/merchantAuthService.js)
-- — the plaintext key is never persisted anywhere, only returned once at
-- issuance time. NULL until a key has been issued for that merchant_user.
ALTER TABLE merchant_users ADD COLUMN api_key_hash TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_merchant_users_api_key_hash
  ON merchant_users(api_key_hash) WHERE api_key_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_merchant_users_merchant ON merchant_users(merchant_id);
