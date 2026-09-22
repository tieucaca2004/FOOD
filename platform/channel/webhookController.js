import { normalizeZaloTextEvent } from "../../src/channel/zalo/messageNormalizer.js"; // generic, read-only reuse
import { sendPlatformTextMessage } from "./zaloClient.js";
import { logger } from "../../src/logger.js";

const INTENT_TO_EVENT = {
  add_to_cart: "ADD_TO_CART",
  checkout: "CHECKOUT_STARTED",
  confirm_order: "ORDER_CREATED",
};

export function createPlatformWebhookHandler({ repos, services, router }) {
  return async function handlePlatformWebhook(req, res) {
    const requestId = req.requestId;

    const event = normalizeZaloTextEvent(req.body);
    if (!event) {
      return res.json({ status: "ignored", event_name: req.body?.event_name || null });
    }

    const isNew = repos.webhookEvents.reserve(event.messageId, req.body.event_name);
    if (!isNew) {
      const cached = repos.webhookEvents.getCachedResponse(event.messageId);
      logger.info("WEBHOOK", "duplicate platform message_id, returning cached result", {
        requestId,
        messageId: event.messageId,
      });
      return res.json(cached || { status: "duplicate", message_id: event.messageId });
    }

    let responsePayload;
    try {
      const customer = services.customers.getOrCreateByZaloUserId(event.zaloUserId, event.displayName);
      const session = services.sessions.getOrCreate(customer.id);
      repos.messages.log({ sessionId: session.id, direction: "in", rawText: event.text });

      const result = await router.handle({ customer, session, text: event.text });
      repos.messages.log({ sessionId: session.id, direction: "out", rawText: result.replyText });

      logFunnelEvents(repos, customer, result);

      const sendResult = await sendPlatformTextMessage(event.zaloUserId, result.replyText);

      responsePayload = {
        status: "processed",
        customer_id: customer.id,
        session_id: result.session.id,
        reply_text: result.replyText,
        responder: "tong_dai_concierge",
        respond_error: sendResult.ok ? null : sendResult.error,
      };
    } catch (err) {
      logger.error("WEBHOOK", "platform processing failed", { requestId, messageId: event.messageId, error: err.message });
      responsePayload = { status: "error", error: err.message };
    }

    repos.webhookEvents.saveResponse(event.messageId, responsePayload);
    const httpStatus = responsePayload.status === "error" ? 500 : 200;
    return res.status(httpStatus).json(responsePayload);
  };
}

function logFunnelEvents(repos, customer, result) {
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
