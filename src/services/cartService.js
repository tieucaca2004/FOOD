import { formatVnd, isValidQuantity, sumLineTotals } from "../domain/money.js";
import { config } from "../config.js";

export class CartError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export class CartService {
  constructor(repos) {
    this.repos = repos;
  }

  getCart(customerId) {
    const cart = this.repos.carts.getOrCreateActive(customerId);
    const items = this.repos.carts.listItems(cart.id);
    return { cart, items, total: sumLineTotals(items) };
  }

  // productId + quantity only — price is always looked up server-side from
  // the products table, never accepted from the caller.
  addItem(customerId, productId, quantity) {
    if (!isValidQuantity(quantity, config.maxItemQuantity)) {
      throw new CartError("INVALID_QUANTITY", "Số lượng không hợp lệ.");
    }
    const product = this.repos.products.findById(productId);
    if (!product) throw new CartError("PRODUCT_NOT_FOUND", "Không tìm thấy món này trong menu.");
    if (!product.available) throw new CartError("PRODUCT_UNAVAILABLE", "Món này hiện đang tạm hết.");

    const cart = this.repos.carts.getOrCreateActive(customerId);
    const existing = this.repos.carts.findItemByProduct(cart.id, productId);
    if (existing) {
      const newQty = existing.quantity + quantity;
      if (!isValidQuantity(newQty, config.maxItemQuantity)) {
        throw new CartError("INVALID_QUANTITY", "Số lượng vượt quá giới hạn cho phép.");
      }
      this.repos.carts.setItemQuantity(existing.id, newQty);
    } else {
      this.repos.carts.addItem(cart.id, productId, quantity, product.price);
    }
    return this.getCart(customerId);
  }

  updateItemQuantity(customerId, cartItemId, quantity) {
    if (!isValidQuantity(quantity, config.maxItemQuantity)) {
      throw new CartError("INVALID_QUANTITY", "Số lượng không hợp lệ.");
    }
    const item = this.repos.carts.findItemById(cartItemId);
    if (!item) throw new CartError("ITEM_NOT_FOUND", "Không tìm thấy món trong giỏ.");
    this.repos.carts.setItemQuantity(cartItemId, quantity);
    return this.getCart(customerId);
  }

  removeItemByProduct(customerId, productId) {
    const cart = this.repos.carts.getOrCreateActive(customerId);
    const item = this.repos.carts.findItemByProduct(cart.id, productId);
    if (!item) throw new CartError("ITEM_NOT_FOUND", "Món này không có trong giỏ.");
    this.repos.carts.removeItem(item.id);
    return this.getCart(customerId);
  }

  removeItemById(customerId, cartItemId) {
    const item = this.repos.carts.findItemById(cartItemId);
    if (!item) throw new CartError("ITEM_NOT_FOUND", "Không tìm thấy món trong giỏ.");
    this.repos.carts.removeItem(cartItemId);
    return this.getCart(customerId);
  }

  clear(customerId) {
    const cart = this.repos.carts.getOrCreateActive(customerId);
    this.repos.carts.clearItems(cart.id);
    return this.getCart(customerId);
  }

  formatCartSummary({ items, total }) {
    if (items.length === 0) return "Giỏ hàng đang trống.";
    const lines = items.map((i) => `${i.product_name} × ${i.quantity} = ${formatVnd(i.unit_price * i.quantity)}`);
    return `${lines.join("\n")}\n\nTạm tính: ${formatVnd(total)}`;
  }
}
