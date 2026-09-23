import { MerchantRepository } from "./merchantRepository.js";
import { MerchantSubscriptionRepository } from "./merchantSubscriptionRepository.js";
import { MerchantProductRepository } from "./merchantProductRepository.js";
import { MerchantCategoryRepository } from "./merchantCategoryRepository.js";
import { MerchantMenuRepository } from "./merchantMenuRepository.js";
import { MenuImportRepository } from "./menuImportRepository.js";
import { CartRepository } from "./cartRepository.js";
import { PlatformCustomerRepository } from "./platformCustomerRepository.js";
import { PlatformSessionRepository } from "./platformSessionRepository.js";
import { PlatformMessageRepository } from "./platformMessageRepository.js";
import { MerchantSessionRepository } from "./merchantSessionRepository.js";
import { AnalyticsRepository } from "./analyticsRepository.js";
import { PlatformWebhookEventRepository } from "./webhookEventRepository.js";
import { PlatformOrderRepository } from "./orderRepository.js";
import { PaymentRepository } from "./paymentRepository.js";
import { DeliveryRepository } from "./deliveryRepository.js";
import { MerchantUserRepository } from "./merchantUserRepository.js";

export function createPlatformRepositories(db) {
  return {
    merchants: new MerchantRepository(db),
    subscriptions: new MerchantSubscriptionRepository(db),
    merchantProducts: new MerchantProductRepository(db),
    merchantCategories: new MerchantCategoryRepository(db),
    merchantMenus: new MerchantMenuRepository(db),
    menuImports: new MenuImportRepository(db),
    carts: new CartRepository(db),
    customers: new PlatformCustomerRepository(db),
    sessions: new PlatformSessionRepository(db),
    messages: new PlatformMessageRepository(db),
    merchantSessions: new MerchantSessionRepository(db),
    analytics: new AnalyticsRepository(db),
    webhookEvents: new PlatformWebhookEventRepository(db),
    orders: new PlatformOrderRepository(db),
    payments: new PaymentRepository(db),
    deliveries: new DeliveryRepository(db),
    merchantUsers: new MerchantUserRepository(db), // Phase 7: merchant authentication identity anchor
  };
}
