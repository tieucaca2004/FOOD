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
