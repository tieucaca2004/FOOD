import { normalizeZaloTextEvent } from "./messageNormalizer.js";
import { verifyZaloSignature } from "./verifySignature.js";
import { sendTextMessage } from "./client.js";
import { logger } from "../../logger.js";

export function createZaloWebhookHandler({ repos, services, router }) {
  return async function handleZaloWebhook(req, res) {
    const requestId = req.requestId;

    if (!verifyZaloSignature(req.rawBody || "", req.headers)) {
      logger.warn("WEBHOOK", "signature verification failed", { requestId });
      return res.status(401).json({ status: "error", error: "invalid signature" });
    }

    const event = normalizeZaloTextEvent(req.body);
    if (!event) {
      // Not a text message we handle (delivery receipt, follow/unfollow,
      // sticker, ...) — ack without processing so Zalo doesn't retry it.
      return res.json({ status: "ignored", event_name: req.body?.event_name || null });
    }

    // Idempotency: a UNIQUE constraint on message_id makes this
    // check-and-reserve atomic — a retried webhook for the same message
    // short-circuits to the cached response instead of reprocessing.
    const isNew = repos.webhookEvents.reserve(event.messageId, req.body.event_name);
    if (!isNew) {
      const cached = repos.webhookEvents.getCachedResponse(event.messageId);
      logger.info("WEBHOOK", "duplicate message_id, returning cached result", {
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

      const { replyText } = await router.handle({ customer, session, text: event.text });

      repos.messages.log({ sessionId: session.id, direction: "out", intent: null, rawText: replyText });

      const sendResult = await sendTextMessage(event.zaloUserId, replyText);

      responsePayload = {
        status: "processed",
        customer_id: customer.id,
        session_id: session.id,
        reply_text: replyText,
        responder: "mary_ordering_engine",
        respond_error: sendResult.ok ? null : sendResult.error,
      };
    } catch (err) {
      logger.error("WEBHOOK", "processing failed", { requestId, messageId: event.messageId, error: err.message });
      responsePayload = { status: "error", error: err.message };
    }

    repos.webhookEvents.saveResponse(event.messageId, responsePayload);
    const httpStatus = responsePayload.status === "error" ? 500 : 200;
    return res.status(httpStatus).json(responsePayload);
  };
}
