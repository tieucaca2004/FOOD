import { isAccountDiscoverable } from "../domain/merchantStatus.js";

/**
 * The single, canonical read/write layer for merchant records per spec
 * §16/§46 ("AI → MerchantDataService → MerchantRepository → Database";
 * "Không cho AI/Controller/Agent → DB trực tiếp"). AgentSearchService
 * (Phase 2), Admin API, and any future caller should go through this —
 * never call MerchantRepository directly for merchant-record reads.
 *
 * Uses the Phase 1 split model (account_status + active), NOT the legacy
 * single `status` string — see domain/merchantStatus.js for why both
 * still exist during migration.
 *
 * Not yet wired into DiscoveryEngine/PlatformRouter in this phase — those
 * are already-tested, frozen components; rewiring them to this service is
 * explicitly Phase 2 ("AgentSearchService... Discovery integration") per
 * the phase plan, not Phase 1.
 */
export class MerchantDataService {
  constructor(repos) {
    this.repos = repos;
  }

  getById(merchantId) {
    return this.repos.merchants.getById(merchantId);
  }

  getBySlug(slug) {
    return this.repos.merchants.getBySlug(slug);
  }

  listAll() {
    return this.repos.merchants.listAll();
  }

  listDiscoverable() {
    return this.repos.merchants
      .listAll()
      .filter((m) => isAccountDiscoverable({ accountStatus: m.account_status, active: m.active }));
  }

  findDiscoverableByNameFragment(text) {
    return this.repos.merchants
      .findByNameFragment(text)
      .filter((m) => isAccountDiscoverable({ accountStatus: m.account_status, active: m.active }));
  }

  // Any-status lookup — used when the caller needs to distinguish "no such
  // merchant" from "merchant exists but is not currently discoverable"
  // (e.g. to reply "quán này hiện không khả dụng" instead of "không tìm thấy").
  findAnyStatusByNameFragment(text) {
    return this.repos.merchants.findByNameFragment(text);
  }

  isDiscoverable(merchant) {
    return isAccountDiscoverable({ accountStatus: merchant.account_status, active: merchant.active });
  }

  getSubscription(merchantId) {
    return this.repos.subscriptions.getActiveByMerchant(merchantId);
  }
}
