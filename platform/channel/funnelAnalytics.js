// Channel-agnostic funnel analytics, recorded from a PlatformRouter result.
// Shared by every inbound channel adapter (Zalo, Telegram).

const INTENT_TO_EVENT = {
  add_to_cart: "ADD_TO_CART",
  checkout: "CHECKOUT_STARTED",
  confirm_order: "ORDER_CREATED",
};

export function logFunnelEvents(repos, customer, result) {
  if (typeof result.searchResultCount === "number") {
    repos.analytics.logSearch({ customerId: customer.id, queryText: result.session.last_search_query, resultCount: result.searchResultCount });
    repos.analytics.logMerchantEvent({ merchantId: null, customerId: customer.id, eventType: "SEARCH", payload: { resultCount: result.searchResultCount } });
  }
  if (result.openedMerchantId) {
    repos.analytics.logMerchantEvent({ merchantId: result.openedMerchantId, customerId: customer.id, eventType: "MERCHANT_VIEW" });
  }
  if (result.merchantIntent && INTENT_TO_EVENT[result.merchantIntent]) {
    repos.analytics.logMerchantEvent({
      merchantId: result.activeMerchantId,
      customerId: customer.id,
      eventType: INTENT_TO_EVENT[result.merchantIntent],
      externalRef: result.orderRef || null,
    });
  }
}
