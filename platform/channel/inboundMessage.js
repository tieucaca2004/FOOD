// Channel updates -> ONE internal inbound shape (pure; no I/O). Used only for what the text normalizers do not carry
// (attachments); the text path keeps its own normalizers byte-for-byte.
//
//   { channel: "telegram"|"zalo", updateId, messageId, externalUserId, externalChatId, displayName, timestamp,
//     text,                    the caption (Telegram) / the message text (Zalo), or null
//     attachments: [{ type: "image", ref, mimeType }],   ref = Telegram file_id | Zalo https URL
//     mediaGroupId, unsupported: null | "voice" | "video" | "sticker" | "file" | ... }
//
// minimisedRaw() is what may be stored as evidence for a CUSTOMER: ids of the message and its media only — never the
// sender object, names, username, chat, text or caption (those live, at most, in the purgeable source file).

const IMAGE_DOC = /^image\/(jpeg|png|webp)$/;

export function fromTelegramUpdate(update) {
  const m = update?.message;
  if (!m || typeof m !== "object" || update.update_id === undefined || m.message_id === undefined || !m.chat || m.chat.id === undefined) return null;
  const from = m.from;
  if (!from || from.id === undefined || from.id === null) return null;
  const attachments = [];
  let unsupported = null;
  if (Array.isArray(m.photo) && m.photo.length) {
    const largest = [...m.photo].sort((a, b) => (b.file_size ?? (b.width ?? 0) * (b.height ?? 0)) - (a.file_size ?? (a.width ?? 0) * (a.height ?? 0)))[0];
    if (largest?.file_id) attachments.push({ type: "image", ref: largest.file_id, mimeType: "image/jpeg", size: largest.file_size ?? null });
  } else if (m.document?.file_id) {
    if (IMAGE_DOC.test(m.document.mime_type ?? "")) attachments.push({ type: "image", ref: m.document.file_id, mimeType: m.document.mime_type, size: m.document.file_size ?? null });
    else unsupported = "file";
  }
  if (!attachments.length && !unsupported) {
    for (const k of ["voice", "audio", "video", "video_note", "sticker", "animation", "location", "contact"]) if (m[k]) unsupported = k;
  }
  if (!attachments.length && !unsupported) return null; // plain text: the text normalizer's business
  const displayName = [from.first_name, from.last_name].filter((p) => typeof p === "string" && p.trim()).join(" ") || from.username || null;
  return {
    channel: "telegram",
    updateId: update.update_id !== undefined ? String(update.update_id) : null,
    messageId: String(m.message_id),
    externalUserId: String(from.id),
    externalChatId: String(m.chat.id),
    displayName,
    timestamp: typeof m.date === "number" ? m.date : null,
    text: typeof m.caption === "string" ? m.caption : null,
    attachments,
    mediaGroupId: m.media_group_id ?? null,
    unsupported,
  };
}

// Zalo OA: user_send_image = { event_name, sender: { id }, message: { msg_id, text?, attachments: [{ type: "image",
// payload: { url, thumbnail } }] }, timestamp } (see platform/channel/zalo/zaloMedia.js for how the shape was checked)
const ZALO_UNSUPPORTED = { user_send_audio: "voice", user_send_video: "video", user_send_sticker: "sticker", user_send_gif: "animation", user_send_file: "file", user_send_location: "location" };

export function fromZaloEvent(body) {
  const name = body?.event_name;
  if (name !== "user_send_image" && !ZALO_UNSUPPORTED[name]) return null;
  const userId = body?.sender?.id;
  const messageId = body?.message?.msg_id || body?.message_id;
  if (!userId || !messageId) return null;
  const attachments =
    name === "user_send_image"
      ? (Array.isArray(body.message?.attachments) ? body.message.attachments : [])
          .filter((a) => (a?.type === "image" || a?.type === undefined) && typeof a?.payload?.url === "string")
          .map((a) => ({ type: "image", ref: a.payload.url, mimeType: null, size: null }))
      : [];
  if (name === "user_send_image" && !attachments.length) return null;
  return {
    channel: "zalo",
    updateId: String(messageId),
    messageId: String(messageId),
    externalUserId: String(userId),
    externalChatId: String(userId),
    displayName: body.sender?.display_name ?? null,
    timestamp: body.timestamp ? Number(body.timestamp) : null,
    text: typeof body.message?.text === "string" && body.message.text.trim() ? body.message.text : null,
    attachments,
    mediaGroupId: null,
    unsupported: ZALO_UNSUPPORTED[name] ?? null,
  };
}

/** The evidence copy of an update for a customer: message + media ids only. */
export function minimisedRaw(inbound) {
  return {
    channel: inbound.channel,
    update_id: inbound.updateId,
    message: {
      message_id: inbound.messageId,
      date: inbound.timestamp,
      media_group_id: inbound.mediaGroupId,
      // a Zalo URL is a signed CDN link to the customer's picture: kept only as "has image"
      attachments: inbound.attachments.map((a) => ({ type: a.type, ...(inbound.channel === "telegram" ? { file_id: a.ref } : {}), mime_type: a.mimeType, size: a.size })),
    },
  };
}
