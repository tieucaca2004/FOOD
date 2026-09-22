// Normalizes a raw Zalo webhook body into the shape the rest of the system
// works with. Returns null if the event isn't a user text message we handle
// (delivery receipts, follow/unfollow, stickers, ...) — the controller acks
// those without further processing.
export function normalizeZaloTextEvent(body) {
  if (!body || body.event_name !== "user_send_text") return null;

  const zaloUserId = body.sender?.id;
  const text = body.message?.text;
  const messageId = body.message?.msg_id || body.message_id;

  if (!zaloUserId || typeof text !== "string" || !messageId) return null;

  return {
    zaloUserId,
    text,
    messageId: String(messageId),
    displayName: body.sender?.display_name || null,
    timestamp: body.timestamp || null,
  };
}
