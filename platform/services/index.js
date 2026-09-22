import { MerchantService } from "./merchantService.js";
import { MerchantDataService } from "./merchantDataService.js";
import { MenuService } from "./menuService.js";
import { SubscriptionService, NullBillingProvider } from "./subscriptionService.js";
import { PlatformCustomerService } from "./platformCustomerService.js";
import { PlatformSessionService } from "./platformSessionService.js";
import { PaymentService } from "./paymentService.js";
import { DeliveryService } from "./deliveryService.js";

export function createPlatformServices(repos) {
  return {
    merchants: new MerchantService(repos), // write-side: onboarding/lifecycle actions
    merchantData: new MerchantDataService(repos), // read-side: the canonical merchant-record lookup (Phase 1)
    menu: new MenuService(repos), // Generic Menu Engine (Phase 3) — generic merchants only, A Tiểu has its own
    subscriptions: new SubscriptionService(repos, new NullBillingProvider()),
    customers: new PlatformCustomerService(repos),
    sessions: new PlatformSessionService(repos),
    payments: new PaymentService(repos),
    deliveries: new DeliveryService(repos),
  };
}
