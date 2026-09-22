import { MERCHANT_STATUS } from "../domain/merchantStatus.js";
import { computeTrialEnd } from "../domain/subscription.js";

export class MerchantOnboardingError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export class MerchantService {
  constructor(repos) {
    this.repos = repos;
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

    const plan = this.repos.subscriptions.getPlan(planId);
    if (!plan) throw new MerchantOnboardingError("PLAN_NOT_FOUND", `plan ${planId} not found`);
    const now = new Date();
    const trialEnd = computeTrialEnd(now, plan);
    this.repos.subscriptions.startTrial(merchantId, planId, now.toISOString(), trialEnd.toISOString());

    return merchant;
  }

  // Admin review step — the only way a merchant becomes discoverable.
  activate(merchantId) {
    const merchant = this.repos.merchants.getById(merchantId);
    if (!merchant) throw new MerchantOnboardingError("MERCHANT_NOT_FOUND", "merchant not found");
    const subscription = this.repos.subscriptions.getActiveByMerchant(merchantId);
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
