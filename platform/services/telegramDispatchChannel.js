import { sendTelegramMessage } from "../channel/telegram/telegramClient.js";

// Dispatch channel "telegram": delivers an order notification to a
// merchant's Telegram chat through the platform's existing Telegram client
// (platform/channel/telegram/telegramClient.js, reused unchanged — Tổng
// Đài's own bot, PLATFORM_TELEGRAM_BOT_TOKEN). The chat id is never known
// here: it is the `destination` the caller read from THAT merchant's own
// dispatch configuration.
//
// Contract of every dispatch channel: send() never throws and answers
// { ok: true } or { ok: false, error }.

// Telegram chat ids: numeric (users, groups: negative) or a public "@channel".
const CHAT_ID = /^(?:-?\d{1,20}|@[A-Za-z][A-Za-z0-9_]{4,31})$/;

export function isValidTelegramDestination(destination) {
  return CHAT_ID.test(String(destination ?? "").trim());
}

export class TelegramDispatchChannel {
  constructor({ send = sendTelegramMessage } = {}) {
    this.send = send;
  }

  validate(destination) {
    return isValidTelegramDestination(destination);
  }

  async deliver({ destination, text }) {
    if (!this.validate(destination)) return { ok: false, error: "INVALID_TELEGRAM_DESTINATION" };
    try {
      const result = await this.send({ chatId: String(destination).trim(), text });
      return result?.ok ? { ok: true } : { ok: false, error: result?.error || "TELEGRAM_SEND_FAILED" };
    } catch (err) {
      return { ok: false, error: err?.message || "TELEGRAM_SEND_FAILED" };
    }
  }
}
