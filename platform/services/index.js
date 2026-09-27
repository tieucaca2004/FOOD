import { MerchantService } from "./merchantService.js";
import { MerchantDataService } from "./merchantDataService.js";
import { MenuService } from "./menuService.js";
import { MenuImportService } from "./menuImportService.js";
import { MenuImageStorage } from "./menuImageStorage.js";
import { createMenuVisionProvider } from "../ai/menu/index.js";
import { CartService } from "./cartService.js";
import { OrderService } from "./orderService.js";
import { ChannelMerchantDispatchPort } from "./channelMerchantDispatchPort.js";
import { TelegramDispatchChannel } from "./telegramDispatchChannel.js";
import { MerchantAuthService } from "./merchantAuthService.js";
import { MerchantOrderService } from "./merchantOrderService.js";
import { SubscriptionService, NullBillingProvider } from "./subscriptionService.js";
import { PlatformCustomerService } from "./platformCustomerService.js";
import { PlatformSessionService } from "./platformSessionService.js";
import { PaymentService } from "./paymentService.js";
import { DeliveryService } from "./deliveryService.js";
import { ProductLanguageService } from "./productLanguageService.js";
import { CustomerMemoryService } from "./customerMemoryService.js";

// `visionProvider`/`imageStorage`/`dispatchPort`/`dispatchChannels` are
// injectable (tests pass deterministic fakes instead of the real
// config-driven ones — see platform/test/helpers/testPlatform.js).
//
// Merchant dispatch: by default every generic order goes to the
// ChannelMerchantDispatchPort, which delivers it over the channel configured
// for THAT merchant (merchant_dispatch_channels). A merchant with no
// configured channel gets exactly the previous behavior (NO_DISPATCH_CHANNEL,
// order stays CREATED) — nothing leaves the system for it.
export function createPlatformServices(repos, { visionProvider, imageStorage, dispatchPort, dispatchChannels } = {}) {
  const merchantData = new MerchantDataService(repos); // read-side: the canonical merchant-record lookup (Phase 1)
  const menu = new MenuService(repos); // Generic Menu Engine (Phase 3) — generic merchants only, A Tiểu has its own
  const cart = new CartService(repos, menu, merchantData); // Generic Cart Engine (Phase 5) — generic merchants only, A Tiểu has its own

  return {
    merchants: new MerchantService(repos), // write-side: onboarding/lifecycle actions
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
    orders: new OrderService(
      repos,
      cart,
      menu,
      merchantData,
      dispatchPort || new ChannelMerchantDispatchPort({ repos, channels: dispatchChannels || { telegram: new TelegramDispatchChannel() } })
    ),
    subscriptions: new SubscriptionService(repos, new NullBillingProvider()),
    customers: new PlatformCustomerService(repos),
    sessions: new PlatformSessionService(repos),
    payments: new PaymentService(repos), // unused/future scaffolding (Phase 6 does not call this)
    deliveries: new DeliveryService(repos), // unused/future scaffolding (Phase 6 does not call this)
    // Merchant Order Visibility / Receive boundary (Phase 7) — merchant
    // side of the same orders/order_items OrderService already owns.
    // See merchantOrderService.js for why this needs no change there.
    merchantAuth: new MerchantAuthService(repos),
    merchantOrders: new MerchantOrderService(repos),
    // Merchant Conversational Learning: customer language -> existing products, per merchant.
    productLanguage: new ProductLanguageService(repos),
    // Customer Memory: preferences, addresses, order references — per customer, structured, evidence-based.
    customerMemory: new CustomerMemoryService(repos),
  };
}
