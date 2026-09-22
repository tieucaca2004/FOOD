export class SessionService {
  constructor(repos) {
    this.repos = repos;
  }

  getOrCreate(customerId, channel = "zalo") {
    return this.repos.sessions.getActiveByCustomer(customerId, channel) || this.repos.sessions.create(customerId, channel);
  }

  update(sessionId, patch) {
    return this.repos.sessions.update(sessionId, patch);
  }

  clearPending(sessionId) {
    return this.repos.sessions.update(sessionId, {
      pendingConfirmation: false,
      pendingOrderId: null,
      pendingCheckoutField: null,
    });
  }
}
