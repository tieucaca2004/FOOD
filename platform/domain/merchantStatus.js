export const MERCHANT_STATUS = Object.freeze({
  PENDING: "PENDING",
  TRIAL: "TRIAL",
  ACTIVE: "ACTIVE",
  SUSPENDED: "SUSPENDED",
  EXPIRED: "EXPIRED",
  CLOSED: "CLOSED",
});

// Discovery only ever surfaces merchants in these statuses — everything
// else (PENDING/SUSPENDED/EXPIRED/CLOSED) is excluded before any ranking.
const DISCOVERABLE = new Set([MERCHANT_STATUS.ACTIVE, MERCHANT_STATUS.TRIAL]);

export function isDiscoverable(status) {
  return DISCOVERABLE.has(status);
}

// ---------------------------------------------------------------------
// Phase 1 (Core Data Layer): the split, spec-mandated model. account_status
// is a pure account-lifecycle concept; subscription lifecycle is tracked
// separately in merchant_subscriptions.status (SUBSCRIPTION_STATUS below).
// `active` is the single boolean Discovery/AgentSearch check — never a
// string comparison scattered across callers.
// ---------------------------------------------------------------------

export const ACCOUNT_STATUS = Object.freeze({
  PENDING: "PENDING",
  ACTIVE: "ACTIVE",
  TEMPORARY_SUSPENDED: "TEMPORARY_SUSPENDED",
  EXPIRED: "EXPIRED",
  CLOSED: "CLOSED",
});

export const SUBSCRIPTION_STATUS = Object.freeze({
  TRIAL: "TRIAL",
  ACTIVE: "ACTIVE",
  EXPIRED: "EXPIRED",
  CANCELLED: "CANCELLED",
});

// Maps the legacy single `merchants.status` value (still the write-through
// API MerchantRepository.setStatus/create expose, for backward
// compatibility with code that hasn't migrated) to the new split fields,
// so a single setStatus() call keeps both models in sync automatically.
const LEGACY_STATUS_TO_ACCOUNT = {
  [MERCHANT_STATUS.PENDING]: { accountStatus: ACCOUNT_STATUS.PENDING, active: false },
  [MERCHANT_STATUS.TRIAL]: { accountStatus: ACCOUNT_STATUS.ACTIVE, active: true },
  [MERCHANT_STATUS.ACTIVE]: { accountStatus: ACCOUNT_STATUS.ACTIVE, active: true },
  [MERCHANT_STATUS.SUSPENDED]: { accountStatus: ACCOUNT_STATUS.TEMPORARY_SUSPENDED, active: false },
  [MERCHANT_STATUS.EXPIRED]: { accountStatus: ACCOUNT_STATUS.EXPIRED, active: false },
  [MERCHANT_STATUS.CLOSED]: { accountStatus: ACCOUNT_STATUS.CLOSED, active: false },
};

export function deriveAccountFieldsFromLegacyStatus(legacyStatus) {
  return LEGACY_STATUS_TO_ACCOUNT[legacyStatus] || { accountStatus: ACCOUNT_STATUS.PENDING, active: false };
}

// The new, single source of truth for "can this merchant ever be
// discovered" — pure data (account_status + active), no string-based
// legacy status involved.
export function isAccountDiscoverable({ accountStatus, active }) {
  return accountStatus === ACCOUNT_STATUS.ACTIVE && Boolean(active);
}
