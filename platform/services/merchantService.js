import { MERCHANT_STATUS } from "../domain/merchantStatus.js";
import { computeTrialEnd, isSubscriptionExpired } from "../domain/subscription.js";

export class MerchantOnboardingError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export class MerchantService {
  constructor(repos, { subscriptions } = {}) {
    this.repos = repos;
    this.subscriptions = subscriptions;
  }

  getById(merchantId) {
    return this.repos.merchants.getById(merchantId);
  }

  listDiscoverable() {
    return this.repos.merchants.listDiscoverable();
  }

  findByNameFragment(text) {
    return this.repos.merchants.findByNameFragment(text);
  }

  // §13 onboarding: create -> PENDING, admin reviews -> ACTIVE/TRIAL.
  // Never auto-activates — a merchant only becomes discoverable after an
  // explicit admin decision.
  onboard({ merchantId, name, slug, module, description, address, phone, planId = "free" }) {
    if (!merchantId || !name || !slug || !module) {
      throw new MerchantOnboardingError("INVALID_INPUT", "merchantId, name, slug, module are required");
    }
    if (this.repos.merchants.getById(merchantId)) {
      throw new MerchantOnboardingError("DUPLICATE_MERCHANT_ID", `merchant_id ${merchantId} already exists`);
    }
    const plan = this.repos.subscriptions.getPlan(planId);
    if (!plan) throw new MerchantOnboardingError("PLAN_NOT_FOUND", `plan ${planId} not found`);
    const now = new Date();
    const trialEnd = computeTrialEnd(now, plan);

    // Merchant row and its subscription commit together or not at all, so a
    // failed onboarding never leaves an orphan merchant blocking a retry.
    const onboardAtomically = this.repos.merchants.db.transaction(() => {
      const merchant = this.repos.merchants.create({
        merchantId,
        name,
        slug,
        module,
        status: MERCHANT_STATUS.PENDING,
        description,
        address,
        phone,
      });
      this.repos.subscriptions.startTrial(merchantId, planId, now.toISOString(), trialEnd.toISOString());
      return merchant;
    });
    return onboardAtomically();
  }

  // Admin review step — the only way a merchant becomes discoverable. It
  // approves a pending merchant or resumes a suspended one; it never brings
  // back an expired subscription (spec §20). That is renew() (spec §43),
  // which requires billing confirmation.
  activate(merchantId) {
    const merchant = this.repos.merchants.getById(merchantId);
    if (!merchant) throw new MerchantOnboardingError("MERCHANT_NOT_FOUND", "merchant not found");
    // expireIfNeeded() applies a lapsed end date first, exactly as a read would.
    const subscription = this.subscriptions
      ? this.subscriptions.expireIfNeeded(merchantId)
      : this.repos.subscriptions.getActiveByMerchant(merchantId);
    if (subscription && (subscription.status === "EXPIRED" || isSubscriptionExpired(subscription))) {
      throw new MerchantOnboardingError("SUBSCRIPTION_EXPIRED", "subscription expired: renew it before activating the merchant");
    }
    const newStatus = subscription?.status === "TRIAL" ? MERCHANT_STATUS.TRIAL : MERCHANT_STATUS.ACTIVE;
    return this.repos.merchants.setStatus(merchantId, newStatus);
  }

  suspend(merchantId) {
    return this.repos.merchants.setStatus(merchantId, MERCHANT_STATUS.SUSPENDED);
  }

  close(merchantId) {
    return this.repos.merchants.setStatus(merchantId, MERCHANT_STATUS.CLOSED);
  }
}
