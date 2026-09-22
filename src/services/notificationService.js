import { config } from "../config.js";
import { formatVnd } from "../domain/money.js";
import { fulfillmentTypeLabel } from "../domain/checkoutFields.js";
import { logger } from "../logger.js";

function formatTelegramMessage(order, customer) {
  const time = new Date(order.updated_at || order.created_at).toLocaleTimeString("vi-VN", {
    hour: "2-digit",
    minute: "2-digit",
  });
  const lines = order.items.map((i) => `🍜 ${i.product_name} × ${i.quantity}\n${formatVnd(i.line_total)}`);
  return [
    "🔔 ĐƠN HÀNG MỚI",
    `#${order.order_code}`,
    `👤 Khách: ${customer.display_name || "Không rõ tên"}`,
    `📱 Zalo: ${customer.zalo_user_id}`,
    ...lines,
    order.delivery_fee > 0 ? `🚚 Phí giao hàng: ${formatVnd(order.delivery_fee)}` : null,
    `💰 TỔNG: ${formatVnd(order.total)}`,
    `📦 Hình thức: ${fulfillmentTypeLabel(order.fulfillment_type)}`,
    order.fulfillment_type === "delivery" ? `📍 Địa chỉ: ${order.delivery_address}` : null,
    order.customer_phone ? `☎️ SĐT: ${order.customer_phone}` : null,
    `⏰ ${time}`,
  ]
    .filter(Boolean)
    .join("\n");
}

export class NotificationService {
  constructor(repos, { telegramSend } = {}) {
    this.repos = repos;
    // Injectable for tests — defaults to a real fetch call to Telegram's API.
    this.telegramSend = telegramSend || defaultTelegramSend;
  }

  // Only ever called after an order reaches CONFIRMED — never before.
  async notifyNewOrder(orderDetail) {
    const customer = this.repos.customers.findById(orderDetail.customer_id);
    const text = formatTelegramMessage(orderDetail, customer);

    if (!config.telegramBotToken || !config.telegramChatId) {
      logger.warn("ORDER", "no notification channel configured, logging only", { orderCode: orderDetail.order_code });
      const record = this.repos.notifications.create({
        orderId: orderDetail.id,
        channel: "log",
        status: "skipped_no_channel",
        payload: { text },
      });
      logger.info("ORDER", text);
      return record;
    }

    try {
      await this.telegramSend({
        botToken: config.telegramBotToken,
        chatId: config.telegramChatId,
        text,
      });
      return this.repos.notifications.create({
        orderId: orderDetail.id,
        channel: "telegram",
        status: "sent",
        payload: { text },
      });
    } catch (err) {
      logger.error("ORDER", "notification failed", { orderCode: orderDetail.order_code, error: err.message });
      return this.repos.notifications.create({
        orderId: orderDetail.id,
        channel: "telegram",
        status: "failed",
        payload: { text },
        error: err.message,
      });
    }
  }
}

async function defaultTelegramSend({ botToken, chatId, text }) {
  const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Telegram API ${res.status}: ${body}`);
  }
}
