// Normalizes a raw Telegram Bot API Update object (POSTed by Telegram to
// our webhook) into the platform's canonical inbound-message shape.
//
// Shape verified against the official Telegram Bot API (core.telegram.org
// itself is unreachable from this environment — network egress blocked,
// same as Phase 8's Zalo work; see Phase 8.x-T audit) via a direct GitHub
// scrape of the official docs (PaulSonOfLars/telegram-bot-api-spec, which
// re-scrapes core.telegram.org daily) and grammY's actively-maintained
// TypeScript type definitions (grammyjs/types), NOT a third-party
// tutorial's prose interpretation:
//   Update:  { update_id: number, message?: Message, ... }
//   Message: { message_id: number, from?: User, chat: Chat, date: number, text?: string }
//   User:    { id: number, is_bot: boolean, first_name: string, last_name?: string, username?: string }
//   Chat:    { id: number, type: "private"|"group"|"supergroup"|"channel", ... }
//
// `from` is OPTIONAL per the official type (e.g. anonymous channel posts)
// — a message with no sender cannot be attributed to any customer, so it
// normalizes to null exactly like a non-text Zalo event does.
//
// Only plain-text private/group messages are handled in this phase (Part
// 8: inbound-only, no Telegram-specific business logic) — anything else
// (edited_message, callback_query, non-text message, missing fields)
// normalizes to null; the webhook controller acks it as "ignored".
export function normalizeTelegramUpdate(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;

  const updateId = body.update_id;
  const message = body.message;
  if (updateId === undefined || updateId === null) return null;
  if (!message || typeof message !== "object" || Array.isArray(message)) return null;

  const messageId = message.message_id;
  const chat = message.chat;
  const text = message.text;
  const from = message.from;

  if (messageId === undefined || messageId === null) return null;
  if (!chat || typeof chat !== "object" || Array.isArray(chat) || chat.id === undefined || chat.id === null) return null;
  if (typeof text !== "string") return null;
  if (from !== undefined && (typeof from !== "object" || from === null || Array.isArray(from) || from.id === undefined || from.id === null)) {
    return null; // malformed `from` (present but shaped wrong) — never guess an identity
  }

  return {
    channel: "telegram",
    updateId: String(updateId),
    messageId: String(messageId),
    externalChatId: String(chat.id),
    externalUserId: from ? String(from.id) : null, // null = no sender (e.g. anonymous channel post) — caller must not process this as a customer message
    text,
    timestamp: typeof message.date === "number" ? message.date : null,
    displayName: buildDisplayName(from),
  };
}

function buildDisplayName(from) {
  if (!from) return null;
  const parts = [from.first_name, from.last_name].filter((p) => typeof p === "string" && p.trim().length > 0);
  if (parts.length > 0) return parts.join(" ");
  return typeof from.username === "string" && from.username.trim().length > 0 ? from.username : null;
}
