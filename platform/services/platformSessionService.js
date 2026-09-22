export class PlatformSessionService {
  constructor(repos) {
    this.repos = repos;
  }

  getOrCreate(customerId) {
    return this.repos.sessions.getActiveByCustomer(customerId) || this.repos.sessions.create(customerId);
  }

  update(sessionId, patch) {
    return this.repos.sessions.update(sessionId, patch);
  }

  enterMerchantContext(sessionId, merchantId, { entrySource, searchQuery, selectedProductRef } = {}) {
    const session = this.repos.sessions.enterMerchantContext(sessionId, merchantId);
    this.repos.merchantSessions.open({
      platformSessionId: sessionId,
      merchantId,
      entrySource,
      searchQuery,
      selectedProductRef,
    });
    return session;
  }

  returnToPlatform(sessionId) {
    this.repos.merchantSessions.closeOpenForSession(sessionId);
    return this.repos.sessions.returnToPlatform(sessionId);
  }
}
