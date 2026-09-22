-- Phase 1 (Core Data Layer): split the old blended merchants.status enum
-- (PENDING/TRIAL/ACTIVE/SUSPENDED/EXPIRED/CLOSED) into two concepts per
-- spec: account_status (PENDING/ACTIVE/TEMPORARY_SUSPENDED/EXPIRED/CLOSED)
-- + a discoverability `active` flag, kept separate from subscription_status
-- (which already lives in merchant_subscriptions.status: TRIAL/ACTIVE/...).
--
-- Additive only: the old `status` column is NOT dropped or renamed — it
-- keeps being written (see MerchantRepository.setStatus/create) so any
-- code/tests that haven't migrated to the new fields keep working
-- unchanged. New code should read account_status/active via
-- MerchantDataService.

ALTER TABLE merchants ADD COLUMN account_status TEXT NOT NULL DEFAULT 'PENDING';
ALTER TABLE merchants ADD COLUMN active INTEGER NOT NULL DEFAULT 0;

-- Backfill existing rows (e.g. the real ATIEU001 merchant from 001's seed)
-- from their current legacy `status` value.
UPDATE merchants SET account_status = 'ACTIVE', active = 1 WHERE status IN ('TRIAL', 'ACTIVE');
UPDATE merchants SET account_status = 'TEMPORARY_SUSPENDED', active = 0 WHERE status = 'SUSPENDED';
UPDATE merchants SET account_status = 'EXPIRED', active = 0 WHERE status = 'EXPIRED';
UPDATE merchants SET account_status = 'CLOSED', active = 0 WHERE status = 'CLOSED';
-- status = 'PENDING' rows keep the column defaults (account_status='PENDING', active=0).
