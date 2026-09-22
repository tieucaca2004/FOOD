import { isSubscriptionExpired } from "../domain/subscription.js";
import { MERCHANT_STATUS } from "../domain/merchantStatus.js";

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
  // to flip an expired TRIAL into SUBSCRIPTION_REQUIRED and the merchant
  // itself into EXPIRED — a business rule, not a guess.
  expireIfNeeded(merchantId) {
    const subscription = this.getActive(merchantId);
    if (!subscription) return null;
    if (!isSubscriptionExpired(subscription)) return subscription;

    this.repos.subscriptions.setStatus(subscription.id, "SUBSCRIPTION_REQUIRED");
    this.repos.merchants.setStatus(merchantId, MERCHANT_STATUS.EXPIRED);
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
