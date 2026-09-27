import { MerchantDispatchPort } from "./merchantDispatch.js";
import { logger } from "../../src/logger.js";

// Generic Merchant Order Dispatch: the MerchantDispatchPort that actually
// delivers a confirmed order to its merchant — for ANY generic merchant,
// over the channel configured for THAT merchant (merchant_dispatch_channels,
// migration 012). Nothing here knows a merchant, a chat id or a bot: the
// destination is read per order from the order's own merchant_id, and the
// transport is a pluggable channel (see telegramDispatchChannel.js).
//
//   OrderService.confirmOrder ── order committed ──► dispatch(order)
//     merchant has no enabled channel  -> NO_DISPATCH_CHANNEL (order stays CREATED, as before)
//     order_dispatches record SENT     -> ALREADY_SENT (never sent twice)
//     another attempt is in flight     -> DISPATCH_IN_PROGRESS
//     channel.deliver() ok             -> SENT     (OrderService -> SENT_TO_MERCHANT)
//     channel.deliver() failed         -> DISPATCH_FAILED (order untouched, retryable)
//
// dispatch() never throws: a delivery problem must never reach the order
// that was already committed before it.

export const DISPATCH_REASON = Object.freeze({
  SENT: "SENT",
  ALREADY_SENT: "ALREADY_SENT",
  NO_DISPATCH_CHANNEL: "NO_DISPATCH_CHANNEL",
  UNSUPPORTED_CHANNEL: "UNSUPPORTED_DISPATCH_CHANNEL",
  IN_PROGRESS: "DISPATCH_IN_PROGRESS",
  FAILED: "DISPATCH_FAILED",
  ERROR: "DISPATCH_ERROR",
});

function vnd(amount) {
  return `${Number(amount).toLocaleString("vi-VN")}đ`;
}

/** The merchant-facing text for one order — built only from that order's own records. */
export function formatOrderNotification({ merchant, order, items, checkout, customer }) {
  const fulfillment =
    checkout?.fulfillment_type === "pickup" ? "Nhận tại quán" : checkout?.fulfillment_type === "delivery" ? "Giao hàng" : "Chưa chọn";
  const phone = checkout?.customer_phone || customer?.phone || null;
  return [
    "🔔 ĐƠN HÀNG MỚI (Tổng Đài)",
    `#${order.order_code}`,
    `🏪 ${merchant.name}`,
    `👤 Khách: ${customer?.display_name || "Không rõ tên"}`,
    ...items.map((i) => `🍜 ${i.product_name} × ${i.quantity} = ${vnd(i.line_total)}`),
    `💰 TỔNG: ${vnd(order.total)}`,
    `📦 Hình thức: ${fulfillment}`,
    checkout?.fulfillment_type === "delivery" && checkout.delivery_address ? `📍 Địa chỉ: ${checkout.delivery_address}` : null,
    phone ? `☎️ SĐT: ${phone}` : null,
    checkout?.note ? `📝 Ghi chú: ${checkout.note}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

export class ChannelMerchantDispatchPort extends MerchantDispatchPort {
  /**
   * @param {object} deps
   * @param {object} deps.repos platform repositories (merchantDispatch, orders, merchants, customers, cartCheckout)
   * @param {Object<string, {deliver: Function, validate?: Function}>} deps.channels channel name -> channel
   */
  constructor({ repos, channels }) {
    super();
    this.repos = repos;
    this.channels = channels;
  }

  async dispatch(order) {
    try {
      return await this._dispatch(order);
    } catch (err) {
      logger.error("DISPATCH", "order dispatch errored", { orderId: order?.id, error: err.message });
      return { delivered: false, reason: DISPATCH_REASON.ERROR };
    }
  }

  async _dispatch(orderRef) {
    // Always the stored order — never fields handed in by a caller.
    const order = this.repos.orders.getById(orderRef.id);
    if (!order) return { delivered: false, reason: DISPATCH_REASON.ERROR };

    const config = this.repos.merchantDispatch.getChannel(order.merchant_id);
    if (!config || !config.enabled) return { delivered: false, reason: DISPATCH_REASON.NO_DISPATCH_CHANNEL };
    const channel = this.channels[config.channel];
    if (!channel) return { delivered: false, reason: DISPATCH_REASON.UNSUPPORTED_CHANNEL };

    const dispatches = this.repos.merchantDispatch;
    const record = dispatches.ensure({ orderId: order.id, merchantId: order.merchant_id, channel: config.channel, destination: config.destination });
    if (record.merchant_id !== order.merchant_id) {
      // cannot happen through ensure(); refuse rather than send across merchants
      throw new Error(`dispatch record ${record.id} does not belong to merchant ${order.merchant_id}`);
    }
    if (record.status === "SENT") return { delivered: true, reason: DISPATCH_REASON.ALREADY_SENT };
    if (!dispatches.claim(record.id, config)) return { delivered: false, reason: DISPATCH_REASON.IN_PROGRESS };

    let result;
    try {
      result = await channel.deliver({ destination: config.destination, text: this._message(order) });
    } catch (err) {
      result = { ok: false, error: err.message };
    }
    if (result?.ok) {
      dispatches.markSent(record.id);
      logger.info("DISPATCH", "order delivered to merchant", { orderCode: order.order_code, merchantId: order.merchant_id, channel: config.channel });
      return { delivered: true, reason: DISPATCH_REASON.SENT };
    }
    dispatches.markFailed(record.id, result?.error);
    logger.warn("DISPATCH", "order delivery failed", { orderCode: order.order_code, merchantId: order.merchant_id, channel: config.channel, error: result?.error });
    return { delivered: false, reason: DISPATCH_REASON.FAILED };
  }

  _message(order) {
    return formatOrderNotification({
      merchant: this.repos.merchants.getById(order.merchant_id),
      order,
      items: this.repos.orders.listItems(order.id),
      checkout: this.repos.cartCheckout.getByCart(order.cart_id),
      customer: this.repos.customers.findById(order.customer_id),
    });
  }
}
