// FOOD Agent multimodal conversation (FORM 15): a customer's photo in the chat -> the channel's existing media fetcher ->
// customerImageEvidence() (the existing byte check + image reader + evidence-first findings) -> ONE structured,
// UNVERIFIED evidence object for the FOOD Agent. This service never writes a reply: the Agent owns the answer.
// Media stays in memory for the one read (nothing is written to disk here; the buffer is dropped after the read);
// size, type and dimensions are checked from the bytes; every step has a deadline; every failure is an evidence state.
// Separate from customer contributions (knowledge review): no candidate, no evidence row, no storage.

const withDeadline = (promise, ms, reason) => {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(`${reason} timed out`), { reason })), Math.max(1, ms));
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
};

/**
 * @param {object} deps
 * @param {(ref: string) => Promise<{buffer: Buffer, mimeType?: string|null}>} [deps.fetchTelegram] telegramFileFetcher
 * @param {(url: string) => Promise<{buffer: Buffer, mimeType?: string|null}>} [deps.fetchZalo] zaloMediaFetcher
 * @param {Function} deps.readEvidence customerImageEvidence (knowledgeIngestAdapter)
 * @param {{name?: string, model?: string, extractEvidence: Function} | null} deps.reader the existing image reader
 */
export function createImageConversation({ fetchTelegram = null, fetchZalo = null, readEvidence, reader, maxImageBytes = 10 * 1024 * 1024, fetchTimeoutMs = 20000, readTimeoutMs = 45000, logger = null, now = () => new Date() }) {
  return {
    /** The evidence of the FIRST image of an inbound message (null when it has none). Never throws. */
    async read(inbound) {
      const images = (inbound?.attachments ?? []).filter((a) => a.type === "image");
      if (!images.length) return null;
      const base = { source: "customer_image", trust: "UNVERIFIED", channel: inbound.channel, message_id: inbound.messageId ?? null, received_at: now().toISOString(), images_sent: images.length, images_read: 0 };
      const fetchMedia = inbound.channel === "telegram" ? fetchTelegram : inbound.channel === "zalo" ? fetchZalo : null;
      if (!reader || !readEvidence) return { ...base, status: "unavailable", reason: "no_image_reader" };
      if (!fetchMedia) return { ...base, status: "unavailable", reason: "no_media_access" };
      const first = images[0];
      if (typeof first.size === "number" && first.size > maxImageBytes) return { ...base, status: "unreadable", reason: "too_large" };
      let media;
      try {
        media = await withDeadline(fetchMedia(first.ref), fetchTimeoutMs, "download");
      } catch (err) {
        logger?.warn?.("AI", "customer image download failed", { channel: inbound.channel, reason: err?.reason ?? "download_failed" });
        return { ...base, status: "unavailable", reason: err?.reason === "download" ? "download_timeout" : "download_failed" };
      }
      try {
        const evidence = await withDeadline(readEvidence({ buffer: media.buffer, claimedMimeType: media.mimeType ?? first.mimeType ?? null, reader, maxBytes: maxImageBytes }), readTimeoutMs, "read");
        return { ...base, ...evidence, images_read: evidence.status === "read" ? 1 : 0, provider: reader.name ?? null, model: reader.model ?? null };
      } catch (err) {
        logger?.warn?.("AI", "customer image reading failed", { channel: inbound.channel, reason: err?.reason ?? "vision_failed" });
        return { ...base, status: "unavailable", reason: err?.reason === "read" ? "vision_timeout" : "vision_failed" };
      } finally {
        media.buffer = null; // the image is not kept: this read was its only use
      }
    },
  };
}
