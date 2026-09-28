import { normalizeTelegramUpdate } from "./telegram/normalizeTelegramUpdate.js";
import { fromTelegramUpdate } from "./inboundMessage.js";
import { sendTelegramMessage } from "./telegram/telegramClient.js";
import { logger } from "../../src/logger.js";

// Namespace prefixes so this channel can never collide with Zalo's values
// in the two GLOBAL, cross-channel-shared columns it reuses (see Phase
// 8.x-T architecture audit):
//   - platform_customers.zalo_user_id (TEXT UNIQUE) — same namespacing
//     technique AtieuMerchantAdapter.js already uses ("platform:<id>")
//     to bridge identity across a boundary without a schema change.
//   - platform_webhook_events.message_id (TEXT UNIQUE) — a raw Telegram
//     update_id is just an opaque integer from Telegram's perspective and
//     could otherwise coincide with a Zalo msg_id.
const CUSTOMER_ID_PREFIX = "telegram:";
const DEDUPE_KEY_PREFIX = "telegram:";

/**
 * Telegram inbound webhook (Phase 8.x-T) — a secondary channel adapter,
 * structurally parallel to platform/channel/webhookController.js (Zalo,
 * Phase 8, frozen) but NOT sharing its code, so Zalo's implementation
 * needs zero changes. From here down, everything is the SAME
 * channel-agnostic pipeline Zalo already uses unmodified: PlatformRouter,
 * AI Concierge, Discovery, Merchant/Menu/Cart/Order — no Telegram-specific
 * business logic exists anywhere past normalizeTelegramUpdate().
 *
 * OUTBOUND: the router's reply is sent back to the originating chat via
 * telegram/telegramClient.js (symmetric to platform/channel/zaloClient.js).
 * A failed send is reported in respond_error, never turned into an error
 * response — the update was processed, so Telegram must not redeliver it.
 */
export function createTelegramWebhookHandler({ repos, services, router, knowledgeIngest = null, contributions = false }) {
  return async function handleTelegramWebhook(req, res) {
    const requestId = req.requestId;

    // Knowledge Group (KNOWLEDGE_INGEST_ENABLED + KNOWLEDGE_GROUP_CHAT_IDS only): the message is EVIDENCE for
    // Food Knowledge, never a customer conversation — stored (idempotent on chat + message id), queued, acked;
    // no reply is sent to the group. A storage failure is a 500, so Telegram redelivers and nothing is lost.
    if (knowledgeIngest?.accepts(req.body)) {
      try {
        const result = knowledgeIngest.receive(req.body);
        return res.json({ status: "ingested", channel: "telegram", ingest_status: result.status });
      } catch (err) {
        logger.error("WEBHOOK", "knowledge ingestion receive failed", { requestId, error: String(err?.message ?? err).slice(0, 200) });
        return res.status(500).json({ status: "error", error: "internal_error" });
      }
    }

    let event = normalizeTelegramUpdate(req.body);
    // Customer contributions (USER_CONTRIBUTIONS_ENABLED): a photo / image document (or unsupported media) is no
    // longer ignored — it goes, normalised, to the same pipeline; the router wrapper answers it. Text is unchanged.
    // FORM 15: a photo / image document is a CONVERSATIONAL message for the FOOD Agent whatever contributions says
    // (it is never silently ignored); other media keep their existing path (contributions only).
    let inbound = null;
    if (!event) {
      const parsed = fromTelegramUpdate(req.body);
      inbound = parsed && (parsed.attachments.length || contributions) ? parsed : null;
      if (inbound) {
        event = { channel: "telegram", updateId: inbound.updateId, messageId: inbound.messageId, externalChatId: inbound.externalChatId, externalUserId: inbound.externalUserId, text: inbound.text ?? "", timestamp: inbound.timestamp, displayName: inbound.displayName };
      }
    }
    if (!event) {
      return res.json({ status: "ignored", channel: "telegram" });
    }
    if (!event.externalUserId) {
      // No sender (e.g. an anonymous channel post) — nothing to attribute
      // a customer/session to. Ack without processing, never guess.
      return res.json({ status: "ignored", channel: "telegram", reason: "missing_sender" });
    }

    // Express 4 ignores this handler's promise, so any throw that escapes it
    // is an unhandled rejection and takes down the whole process. Every
    // idempotency-store call below is therefore guarded individually.
    const dedupeKey = `${DEDUPE_KEY_PREFIX}${event.updateId}`;
    let isNew;
    try {
      isNew = repos.webhookEvents.reserve(dedupeKey, "telegram_message");
    } catch (err) {
      // Nothing was recorded, so Telegram's redelivery will be processed normally.
      logger.error("WEBHOOK", "telegram idempotency reserve failed", { requestId, updateId: event.updateId, error: err.message });
      return res.status(500).json({ status: "error", error: "internal_error" });
    }
    if (!isNew) {
      let cached = null;
      try {
        cached = repos.webhookEvents.getCachedResponse(dedupeKey);
      } catch (err) {
        // Already reserved: must never fall through to processing it again.
        logger.error("WEBHOOK", "telegram cached response lookup failed", { requestId, updateId: event.updateId, error: err.message });
      }
      logger.info("WEBHOOK", "duplicate telegram update_id, returning cached result", {
        requestId,
        updateId: event.updateId,
      });
      return res.json(cached || { status: "duplicate", channel: "telegram", update_id: event.updateId });
    }

    let responsePayload;
    try {
      const namespacedCustomerId = `${CUSTOMER_ID_PREFIX}${event.externalUserId}`;
      const customer = services.customers.getOrCreateByZaloUserId(namespacedCustomerId, event.displayName);
      const session = services.sessions.getOrCreate(customer.id);

      repos.messages.log({ sessionId: session.id, direction: "in", rawText: inbound ? `[${inbound.attachments.length ? "ảnh" : inbound.unsupported}]${inbound.text ? ` ${inbound.text}` : ""}` : event.text });

      const result = await router.handle({ customer, session, text: event.text, ...(inbound && { inbound }) });

      if (!inbound || result.replyText) repos.messages.log({ sessionId: session.id, direction: "out", rawText: result.replyText });

      const sendResult = result.replyText
        ? await sendTelegramMessage({ chatId: event.externalChatId, text: result.replyText })
        : { ok: true };

      responsePayload = {
        status: "processed",
        channel: "telegram",
        customer_id: customer.id,
        session_id: result.session.id,
        reply_text: result.replyText,
        respond_error: sendResult.ok ? null : sendResult.error,
      };
    } catch (err) {
      logger.error("WEBHOOK", "telegram processing failed", { requestId, updateId: event.updateId, error: err.message });
      // Detail stays in the server log only: this payload is both returned
      // to the caller and persisted as the cached response for replays.
      responsePayload = { status: "error", error: "internal_error" };
    }

    try {
      repos.webhookEvents.saveResponse(dedupeKey, responsePayload);
    } catch (err) {
      // Processing already happened; a redelivery gets the duplicate
      // placeholder rather than being processed a second time.
      logger.error("WEBHOOK", "telegram response cache write failed", { requestId, updateId: event.updateId, error: err.message });
    }
    const httpStatus = responsePayload.status === "error" ? 500 : 200;
    return res.status(httpStatus).json(responsePayload);
  };
}
