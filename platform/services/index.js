import { MerchantService } from "./merchantService.js";
import { MerchantDataService } from "./merchantDataService.js";
import { MenuService } from "./menuService.js";
import { MenuImportService } from "./menuImportService.js";
import { MenuImageStorage } from "./menuImageStorage.js";
import { createMenuVisionProvider } from "../ai/menu/index.js";
import { CartService } from "./cartService.js";
import { OrderService } from "./orderService.js";
import { NullMerchantDispatchPort } from "./merchantDispatch.js";
import { MerchantAuthService } from "./merchantAuthService.js";
import { MerchantOrderService } from "./merchantOrderService.js";
import { SubscriptionService, NullBillingProvider } from "./subscriptionService.js";
import { PlatformCustomerService } from "./platformCustomerService.js";
import { PlatformSessionService } from "./platformSessionService.js";
import { PaymentService } from "./paymentService.js";
import { DeliveryService } from "./deliveryService.js";

// `visionProvider`/`imageStorage`/`dispatchPort` are injectable (tests
// pass deterministic fakes instead of the real config-driven ones — see
// platform/test/helpers/testPlatform.js).
export function createPlatformServices(repos, { visionProvider, imageStorage, dispatchPort } = {}) {
  const subscriptions = new SubscriptionService(repos, new NullBillingProvider());
  const merchantData = new MerchantDataService(repos, { subscriptions }); // read-side: the canonical merchant-record lookup (Phase 1)
  const menu = new MenuService(repos); // Generic Menu Engine (Phase 3) — generic merchants only, A Tiểu has its own
  const cart = new CartService(repos, menu, merchantData); // Generic Cart Engine (Phase 5) — generic merchants only, A Tiểu has its own

  return {
    merchants: new MerchantService(repos, { subscriptions }), // write-side: onboarding/lifecycle actions
    merchantData,
    menu,
    menuImport: new MenuImportService({
      repos,
      menuService: menu,
      visionProvider: visionProvider || createMenuVisionProvider(),
      imageStorage: imageStorage || new MenuImageStorage(),
    }),
    cart,
    // Generic Order + Dispatch Engine (Phase 6) — generic merchants only,
    // A Tiểu has its own order engine. No payment/delivery dependency —
    // see orderService.js class doc for the business-model boundary.
    orders: new OrderService(repos, cart, menu, merchantData, dispatchPort || new NullMerchantDispatchPort()),
    subscriptions,
    customers: new PlatformCustomerService(repos),
    sessions: new PlatformSessionService(repos),
    payments: new PaymentService(repos), // unused/future scaffolding (Phase 6 does not call this)
    deliveries: new DeliveryService(repos), // unused/future scaffolding (Phase 6 does not call this)
    // Merchant Order Visibility / Receive boundary (Phase 7) — merchant
    // side of the same orders/order_items OrderService already owns.
    // See merchantOrderService.js for why this needs no change there.
    merchantAuth: new MerchantAuthService(repos),
    merchantOrders: new MerchantOrderService(repos),
  };
}
