import { formatVnd } from "../domain/money.js";
import { fulfillmentTypeLabel } from "../domain/checkoutFields.js";
import { assertTransition, ORDER_STATUS } from "../domain/orderStateMachine.js";
import { logger } from "../logger.js";

export class OrderError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export class OrderService {
  constructor(repos, notificationService) {
    this.repos = repos;
    this.notificationService = notificationService;
  }

  getById(id) {
    return this.repos.orders.getById(id);
  }

  getDetail(id) {
    const order = this.repos.orders.getById(id);
    if (!order) return null;
    return {
      ...order,
      items: this.repos.orders.listItems(id),
      events: this.repos.orders.listEvents(id),
    };
  }

  // Starts (or resumes) the checkout for a customer's current cart.
  // Snapshots cart contents into order_items right away so later cart edits
  // never retroactively change an in-flight checkout.
  startCheckout(customer, cart, cartItems) {
    if (cartItems.length === 0) {
      throw new OrderError("CART_EMPTY", "Giỏ hàng đang trống, anh/chị chọn món trước nha.");
    }
    let order = this.repos.orders.findOpenByCart(cart.id);
    if (!order) {
      order = this.repos.orders.createDraftFromCart({
        customerId: customer.id,
        cartId: cart.id,
        cartItems,
      });
    }
    return order;
  }

  nextMissingCheckoutField(order, customer) {
    if (!order.fulfillment_type) return "fulfillment_type";
    if (order.fulfillment_type === "delivery" && !order.delivery_address) return "address";
    if (!order.customer_phone && !customer.phone) return "phone";
    return null;
  }

  applyCheckoutField(order, field, value, deliveryFeeVnd) {
    if (field === "fulfillment_type") {
      const deliveryFee = value === "delivery" ? deliveryFeeVnd : 0;
      return this.repos.orders.updateCheckoutFields(order.id, { fulfillmentType: value, deliveryFee });
    }
    if (field === "address") {
      return this.repos.orders.updateCheckoutFields(order.id, { deliveryAddress: value });
    }
    if (field === "phone") {
      return this.repos.orders.updateCheckoutFields(order.id, { customerPhone: value });
    }
    throw new OrderError("UNKNOWN_FIELD", `Unknown checkout field: ${field}`);
  }

  moveToPendingConfirmation(order) {
    assertTransition(order.status, ORDER_STATUS.PENDING_CONFIRMATION);
    return this.repos.orders.transitionStatus(order.id, order.status, ORDER_STATUS.PENDING_CONFIRMATION, "checkout info complete");
  }

  formatOrderSummary(order, items, customer) {
    const lines = items.map((i) => `${i.product_name} × ${i.quantity} — ${formatVnd(i.line_total)}`);
    const fulfillment = fulfillmentTypeLabel(order.fulfillment_type);
    const phone = order.customer_phone || customer.phone || "";
    return [
      `ĐƠN HÀNG #${order.order_code}`,
      ...lines,
      order.delivery_fee > 0 ? `Phí giao hàng: ${formatVnd(order.delivery_fee)}` : null,
      `Tổng: ${formatVnd(order.total)}`,
      `Hình thức: ${fulfillment}`,
      order.fulfillment_type === "delivery" ? `Địa chỉ: ${order.delivery_address}` : null,
      phone ? `SĐT: ${phone}` : null,
      "",
      "Xác nhận đặt món? (trả lời \"Xác nhận\" hoặc \"Hủy\")",
    ]
      .filter(Boolean)
      .join("\n");
  }

  async confirm(order, cart) {
    assertTransition(order.status, ORDER_STATUS.CONFIRMED);
    const confirmed = this.repos.orders.transitionStatus(order.id, order.status, ORDER_STATUS.CONFIRMED, "customer confirmed");
    this.repos.carts.setStatus(cart.id, "ordered");
    logger.info("ORDER", "order confirmed", { orderId: order.id, orderCode: order.order_code });
    await this.notificationService.notifyNewOrder(this.getDetail(confirmed.id));
    return confirmed;
  }

  cancel(order, note) {
    assertTransition(order.status, ORDER_STATUS.CANCELLED);
    return this.repos.orders.transitionStatus(order.id, order.status, ORDER_STATUS.CANCELLED, note || "cancelled");
  }

  // Used by the REST admin API to move an order through kitchen states.
  transition(orderId, toStatus, note) {
    const order = this.repos.orders.getById(orderId);
    if (!order) throw new OrderError("ORDER_NOT_FOUND", "Order not found", 404);
    assertTransition(order.status, toStatus);
    return this.repos.orders.transitionStatus(order.id, order.status, toStatus, note);
  }
}
