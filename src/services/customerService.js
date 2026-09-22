export class CustomerService {
  constructor(repos) {
    this.repos = repos;
  }

  getOrCreateByZaloUserId(zaloUserId, displayName) {
    const existing = this.repos.customers.findByZaloUserId(zaloUserId);
    if (existing) {
      if (displayName && displayName !== existing.display_name) {
        return this.repos.customers.updateProfile(existing.id, { displayName });
      }
      return existing;
    }
    return this.repos.customers.create({ zaloUserId, displayName });
  }

  recordPhone(customerId, phone) {
    return this.repos.customers.updateProfile(customerId, { phone });
  }

  getById(id) {
    return this.repos.customers.findById(id);
  }
}
