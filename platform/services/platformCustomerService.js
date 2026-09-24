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
    try {
      return this.repos.customers.create({ zaloUserId, displayName });
    } catch (err) {
      // Another writer created this identity between our read and insert;
      // the UNIQUE constraint kept it single, so converge on that row.
      if (String(err.message).includes("UNIQUE constraint failed: platform_customers.zalo_user_id")) {
        return this.repos.customers.findByZaloUserId(zaloUserId);
      }
      throw err;
    }
  }

  getById(id) {
    return this.repos.customers.findById(id);
  }
}
