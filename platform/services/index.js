import { MerchantService } from "./merchantService.js";
import { SubscriptionService, NullBillingProvider } from "./subscriptionService.js";
import { PlatformCustomerService } from "./platformCustomerService.js";
import { PlatformSessionService } from "./platformSessionService.js";
import { PaymentService } from "./paymentService.js";
import { DeliveryService } from "./deliveryService.js";

export function createPlatformServices(repos) {
  return {
    merchants: new MerchantService(repos),
    subscriptions: new SubscriptionService(repos, new NullBillingProvider()),
    customers: new PlatformCustomerService(repos),
    sessions: new PlatformSessionService(repos),
    payments: new PaymentService(repos),
    deliveries: new DeliveryService(repos),
  };
}
