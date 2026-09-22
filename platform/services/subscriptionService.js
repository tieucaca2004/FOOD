import { isSubscriptionExpired } from "../domain/subscription.js";
import { MERCHANT_STATUS, SUBSCRIPTION_STATUS } from "../domain/merchantStatus.js";

// SubscriptionService / BillingProvider abstraction per spec §15. No real
// payment gateway is integrated in V1 — expireIfNeeded() only ever flips
// status based on dates already in the DB, never calls a billing API.
export class SubscriptionService {
  constructor(repos, billingProvider) {
    this.repos = repos;
    this.billingProvider = billingProvider;
  }

  getActive(merchantId) {
    return this.repos.subscriptions.getActiveByMerchant(merchantId);
  }

  // Called opportunistically (e.g. before Discovery reads merchant status)
  // per spec §20: subscription_status -> EXPIRED, account_status -> EXPIRED,
  // active -> false. merchants.setStatus() dual-writes account_status/active
  // from the legacy EXPIRED value, so this one call satisfies both models.
  expireIfNeeded(merchantId) {
    const subscription = this.getActive(merchantId);
    if (!subscription) return null;
    if (!isSubscriptionExpired(subscription)) return subscription;

    this.repos.subscriptions.setStatus(subscription.id, SUBSCRIPTION_STATUS.EXPIRED);
    this.repos.merchants.setStatus(merchantId, MERCHANT_STATUS.EXPIRED);
    return this.repos.subscriptions.getActiveByMerchant(merchantId);
  }

  // Spec §43: on renewal, subscription_status -> ACTIVE, account_status ->
  // ACTIVE, active -> true. Never called automatically — a real renewal
  // requires a real billing confirmation (NullBillingProvider.charge()
  // always throws), so this is only reachable from an admin action or a
  // future real BillingProvider callback, never from AI/customer text.
  renew(merchantId, expiresAt) {
    const subscription = this.getActive(merchantId);
    if (!subscription) throw new Error(`No subscription found for merchant ${merchantId}`);

    this.repos.subscriptions.setStatus(subscription.id, SUBSCRIPTION_STATUS.ACTIVE);
    this.repos.subscriptions.setExpiresAt(subscription.id, expiresAt);
    this.repos.merchants.setStatus(merchantId, MERCHANT_STATUS.ACTIVE);
    return this.repos.subscriptions.getActiveByMerchant(merchantId);
  }
}

// No real payment gateway credential available — this NEVER claims to have
// billed anyone. It exists so SubscriptionService has a real interface to
// call once a BillingProvider is integrated.
export class NullBillingProvider {
  async charge(_subscription) {
    throw new Error("NullBillingProvider: no billing provider configured — cannot charge");
  }
}
