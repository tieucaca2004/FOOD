import { DELIVERY_STATUS } from "../domain/paymentStatus.js";

// DeliveryProvider interface (merchant self-delivery / platform delivery /
// third-party — spec §25). NullDeliveryProvider never invents a quote or
// fee — it honestly reports "not available" until a real provider (or the
// merchant's own delivery_config) is wired in.
export class DeliveryProvider {
  async quote(_order) {
    throw new Error("DeliveryProvider.quote not implemented");
  }
}

export class NullDeliveryProvider extends DeliveryProvider {
  async quote(_order) {
    return { available: false, amount: null };
  }
}

export class DeliveryService {
  constructor(repos, provider = new NullDeliveryProvider()) {
    this.repos = repos;
    this.provider = provider;
  }

  async createDeliveryForOrder(order) {
    const quote = await this.provider.quote(order);
    return this.repos.deliveries.create({
      orderId: order.id,
      provider: this.provider instanceof NullDeliveryProvider ? "none" : "unknown",
      status: quote.available ? DELIVERY_STATUS.QUOTED : DELIVERY_STATUS.UNASSIGNED,
      quoteAmount: quote.amount,
    });
  }
}
