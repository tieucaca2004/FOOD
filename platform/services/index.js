import { MerchantService } from "./merchantService.js";
import { MerchantDataService } from "./merchantDataService.js";
import { MenuService } from "./menuService.js";
import { MenuImportService } from "./menuImportService.js";
import { MenuImageStorage } from "./menuImageStorage.js";
import { createMenuVisionProvider } from "../ai/menu/index.js";
import { SubscriptionService, NullBillingProvider } from "./subscriptionService.js";
import { PlatformCustomerService } from "./platformCustomerService.js";
import { PlatformSessionService } from "./platformSessionService.js";
import { PaymentService } from "./paymentService.js";
import { DeliveryService } from "./deliveryService.js";

// `visionProvider`/`imageStorage` are injectable (tests pass a
// deterministic fake vision provider and a temp-dir storage instead of
// the real config-driven ones — see platform/test/helpers/testPlatform.js).
export function createPlatformServices(repos, { visionProvider, imageStorage } = {}) {
  const menu = new MenuService(repos); // Generic Menu Engine (Phase 3) — generic merchants only, A Tiểu has its own

  return {
    merchants: new MerchantService(repos), // write-side: onboarding/lifecycle actions
    merchantData: new MerchantDataService(repos), // read-side: the canonical merchant-record lookup (Phase 1)
    menu,
    menuImport: new MenuImportService({
      repos,
      menuService: menu,
      visionProvider: visionProvider || createMenuVisionProvider(),
      imageStorage: imageStorage || new MenuImageStorage(),
    }),
    subscriptions: new SubscriptionService(repos, new NullBillingProvider()),
    customers: new PlatformCustomerService(repos),
    sessions: new PlatformSessionService(repos),
    payments: new PaymentService(repos),
    deliveries: new DeliveryService(repos),
  };
}
