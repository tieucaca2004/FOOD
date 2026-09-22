import { PAYMENT_STATUS } from "../domain/paymentStatus.js";

// PaymentProvider interface: a real integration implements charge()/etc.
// NullPaymentProvider never claims success — it only ever produces PENDING,
// honestly reflecting "not integrated yet". No AI or client input can ever
// set a payment to PAID — only a real provider callback would.
export class PaymentProvider {
  async createIntent(_order) {
    throw new Error("PaymentProvider.createIntent not implemented");
  }
}

export class NullPaymentProvider extends PaymentProvider {
  async createIntent(_order) {
    return { status: PAYMENT_STATUS.PENDING, providerRef: null };
  }
}

export class PaymentService {
  constructor(repos, provider = new NullPaymentProvider()) {
    this.repos = repos;
    this.provider = provider;
  }

  async createPaymentIntent(order) {
    const intent = await this.provider.createIntent(order);
    return this.repos.payments.create({
      orderId: order.id,
      provider: this.provider instanceof NullPaymentProvider ? "none" : "unknown",
      status: intent.status,
      amount: order.total,
    });
  }
}
