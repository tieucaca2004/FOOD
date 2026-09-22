import { platformConfig } from "../config.js";

// Trial length is never hard-coded: it comes from the plan row
// (plans.trial_days) or, if that's null, the platform-wide
// DEFAULT_TRIAL_DAYS env var — both configuration, never a literal in code.
export function resolveTrialDays(plan) {
  return plan.trial_days ?? platformConfig.defaultTrialDays;
}

export function computeTrialEnd(startedAt, plan) {
  const days = resolveTrialDays(plan);
  const end = new Date(startedAt);
  end.setDate(end.getDate() + days);
  return end;
}

export function isSubscriptionExpired(subscription, now = new Date()) {
  if (!subscription.expires_at && !subscription.trial_ends_at) return false;
  const boundary = subscription.status === "TRIAL" ? subscription.trial_ends_at : subscription.expires_at;
  if (!boundary) return false;
  return new Date(boundary) < now;
}
