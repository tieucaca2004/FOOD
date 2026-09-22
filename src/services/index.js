import { CustomerService } from "./customerService.js";
import { SessionService } from "./sessionService.js";
import { MenuService } from "./menuService.js";
import { CartService } from "./cartService.js";
import { OrderService } from "./orderService.js";
import { NotificationService } from "./notificationService.js";

export function createServices(repos, { telegramSend } = {}) {
  const notifications = new NotificationService(repos, { telegramSend });
  return {
    customers: new CustomerService(repos),
    sessions: new SessionService(repos),
    menu: new MenuService(repos),
    cart: new CartService(repos),
    orders: new OrderService(repos, notifications),
    notifications,
  };
}
