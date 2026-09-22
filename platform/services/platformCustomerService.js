export class PlatformCustomerService {
  constructor(repos) {
    this.repos = repos;
  }

  getOrCreateByZaloUserId(zaloUserId, displayName) {
    const existing = this.repos.customers.findByZaloUserId(zaloUserId);
    if (existing) {
      if (displayName && displayName !== existing.display_name) {
        return this.repos.customers.updateDisplayName(existing.id, displayName);
      }
      return existing;
    }
    return this.repos.customers.create({ zaloUserId, displayName });
  }

  getById(id) {
    return this.repos.customers.findById(id);
  }
}
