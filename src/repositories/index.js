import { CustomerRepository } from "./customerRepository.js";
import { SessionRepository } from "./sessionRepository.js";
import { MessageRepository } from "./messageRepository.js";
import { WebhookEventRepository } from "./webhookEventRepository.js";
import { ProductRepository } from "./productRepository.js";
import { CategoryRepository } from "./categoryRepository.js";
import { CartRepository } from "./cartRepository.js";
import { OrderRepository } from "./orderRepository.js";
import { BusinessSettingsRepository } from "./businessSettingsRepository.js";
import { NotificationRepository } from "./notificationRepository.js";
import { PromotionRepository } from "./promotionRepository.js";

export function createRepositories(db) {
  return {
    customers: new CustomerRepository(db),
    sessions: new SessionRepository(db),
    messages: new MessageRepository(db),
    webhookEvents: new WebhookEventRepository(db),
    products: new ProductRepository(db),
    categories: new CategoryRepository(db),
    carts: new CartRepository(db),
    orders: new OrderRepository(db),
    settings: new BusinessSettingsRepository(db),
    notifications: new NotificationRepository(db),
    promotions: new PromotionRepository(db),
  };
}
