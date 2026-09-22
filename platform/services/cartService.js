import { isValidQuantity, sumLineTotals } from "../../src/domain/money.js"; // generic pure utility — read-only reuse
import { isAccountDiscoverable } from "../domain/merchantStatus.js";
import { platformConfig } from "../config.js";

/**
 * Generic Cart Engine (Phase 5): the sole business authority for cart
 * state, shared by every merchant on the platform — no merchant-specific
 * cart logic exists or is ever added here (spec §0/§3). A Tiểu keeps its
 * own, separate cart entirely inside src/ (AtieuMerchantAdapter never
 * calls this class).
 *
 * DOCUMENTED POLICIES (spec §35):
 * - Ownership: a cart belongs to exactly one platform_customers.id
 *   (reused identity from Phase 1/2 — no new identity system). Every
 *   read/mutation verifies customerId === cart.customer_id.
 * - One cart = one merchant: a cart's merchant_id is fixed at creation
 *   and never changes. A customer may hold separate ACTIVE carts for
 *   different merchants at once (normal multi-merchant shopping) — this
 *   is not "mixing". addItem takes an explicit merchantId from the
 *   caller and rejects with CART_MERCHANT_MISMATCH before ever looking
 *   at the product if it doesn't match the cart's own merchant_id.
 * - Price authority: addItem takes only productId + quantity for
 *   pricing purposes — unit_price is always read from MenuService
 *   (never from a caller-supplied field) and snapshotted onto the cart
 *   item at add-time. A later menu price change never reprices an item
 *   already in a cart (spec §18) — that's Phase 6's order-time concern,
 *   not Phase 5's.
 * - Merchant status: only an ACTIVE + routable merchant may get a NEW
 *   cart (spec §12). An existing cart for a merchant that later becomes
 *   inactive is left alone — this phase does not implement any
 *   automatic cart expiry/cancellation.
 * - Quantity: a positive integer up to platformConfig.cartMaxItemQuantity.
 *   updateItemQuantity(..., 0) removes the item (documented choice).
 * - Modifiers/options: deferred to a later phase (spec §23) — cart_items
 *   has no option/variant columns yet; nothing here assumes their absence
 *   in a way that would block adding them (a future migration can add an
 *   options_json/product_option_id column without touching this contract).
 */
export class CartError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function hydrateItem(row) {
  return { ...row, subtotal: row.unit_price * row.quantity };
}

export class CartService {
  constructor(repos, menuService, merchantDataService) {
    this.repos = repos;
    this.menuService = menuService;
    this.merchantDataService = merchantDataService;
  }

  _requireRoutableMerchant(merchantId) {
    const merchant = this.merchantDataService.getById(merchantId);
    if (!merchant) throw new CartError("MERCHANT_NOT_FOUND", `Merchant ${merchantId} not found`, 404);
    if (!isAccountDiscoverable({ accountStatus: merchant.account_status, active: merchant.active })) {
      throw new CartError("MERCHANT_NOT_ACTIVE", `Merchant ${merchantId} is not active`, 403);
    }
    return merchant;
  }

  _ownedCart(customerId, cartId) {
    const cart = this.repos.carts.getById(cartId);
    if (!cart) throw new CartError("CART_NOT_FOUND", `Cart ${cartId} not found`, 404);
    if (cart.customer_id !== customerId) {
      throw new CartError("CART_NOT_OWNED", `Cart ${cartId} does not belong to this customer`, 403);
    }
    if (cart.status !== "ACTIVE") {
      throw new CartError("CART_INACTIVE", `Cart ${cartId} is not active`, 409);
    }
    return cart;
  }

  _hydrate(cart) {
    const items = this.repos.carts.listItems(cart.id).map(hydrateItem);
    return { ...cart, items, total: sumLineTotals(items), isEmpty: items.length === 0 };
  }

  // Only an ACTIVE + routable merchant gets a brand-new cart; fetching an
  // already-existing one is always allowed regardless of later merchant
  // status changes (spec §12's "discovery visibility vs cart
  // authorization can differ").
  createCart(customerId, merchantId) {
    const existing = this.repos.carts.getActiveByCustomerAndMerchant(customerId, merchantId);
    if (existing) return this._hydrate(existing);
    this._requireRoutableMerchant(merchantId);
    return this._hydrate(this.repos.carts.create(customerId, merchantId));
  }

  getOrCreateCart(customerId, merchantId) {
    return this.createCart(customerId, merchantId);
  }

  getCart(customerId, cartId) {
    return this._hydrate(this._ownedCart(customerId, cartId));
  }

  isEmpty(customerId, cartId) {
    return this.getCart(customerId, cartId).isEmpty;
  }

  listItems(customerId, cartId) {
    return this.getCart(customerId, cartId).items;
  }

  getItem(customerId, cartId, itemId) {
    this._ownedCart(customerId, cartId);
    const item = this.repos.carts.findItemById(itemId);
    if (!item || item.cart_id !== cartId) {
      throw new CartError("CART_ITEM_NOT_FOUND", `Item ${itemId} not found in cart ${cartId}`, 404);
    }
    return hydrateItem(item);
  }

  calculateTotals(customerId, cartId) {
    const cart = this.getCart(customerId, cartId);
    return { subtotal: cart.total, itemCount: cart.items.length };
  }

  // Caller supplies merchantId + productId + quantity only — price is
  // always looked up server-side via MenuService, never trusted from a
  // client/AI-supplied unit_price or subtotal field (those fields are
  // simply never read by this method, whatever the caller sends).
  addItem(customerId, cartId, merchantId, productId, quantity) {
    if (!isValidQuantity(quantity, platformConfig.cartMaxItemQuantity)) {
      throw new CartError("INVALID_QUANTITY", "Quantity must be a positive integer within the allowed limit");
    }
    const cart = this._ownedCart(customerId, cartId);
    if (merchantId !== cart.merchant_id) {
      throw new CartError("CART_MERCHANT_MISMATCH", `Cart ${cartId} belongs to merchant ${cart.merchant_id}, not ${merchantId}`);
    }

    // Ownership + existence in one call — MenuService.getProduct()
    // deliberately reports both "doesn't exist" and "belongs to another
    // merchant" as the same PRODUCT_NOT_FOUND (a Phase 3 security choice
    // against leaking cross-tenant existence); this cart layer respects
    // that boundary rather than bypassing MenuService for a more specific
    // code. The pre-check above already gives a clear, specific
    // CART_MERCHANT_MISMATCH for the common case of an honest caller
    // naming the wrong merchant.
    const product = this.menuService.getProduct(cart.merchant_id, productId);
    if (!product.available) {
      throw new CartError("PRODUCT_UNAVAILABLE", `Product ${productId} is currently unavailable`);
    }
    if (!this.menuService.isMenuVisible(cart.merchant_id)) {
      throw new CartError("PRODUCT_UNAVAILABLE", `Merchant ${cart.merchant_id}'s menu is not currently published`);
    }

    const db = this.repos.carts.db;
    const tx = db.transaction(() => {
      const existing = this.repos.carts.findItemByProduct(cartId, productId);
      if (existing) {
        const newQty = existing.quantity + quantity;
        if (!isValidQuantity(newQty, platformConfig.cartMaxItemQuantity)) {
          throw new CartError("INVALID_QUANTITY", "Combined quantity exceeds the allowed limit");
        }
        this.repos.carts.setItemQuantity(existing.id, newQty);
        this.repos.carts.touch(cartId);
      } else {
        this.repos.carts.addItem(cartId, cart.merchant_id, productId, product.name, product.price, quantity);
      }
    });
    tx();

    return this.getCart(customerId, cartId);
  }

  // quantity === 0 removes the item (documented choice, spec §14).
  updateItemQuantity(customerId, cartId, itemId, quantity) {
    this._ownedCart(customerId, cartId);
    const item = this.repos.carts.findItemById(itemId);
    if (!item || item.cart_id !== cartId) {
      throw new CartError("CART_ITEM_NOT_FOUND", `Item ${itemId} not found in cart ${cartId}`, 404);
    }

    if (quantity === 0) {
      this.repos.carts.removeItem(itemId);
      this.repos.carts.touch(cartId);
      return this.getCart(customerId, cartId);
    }
    if (!isValidQuantity(quantity, platformConfig.cartMaxItemQuantity)) {
      throw new CartError("INVALID_QUANTITY", "Quantity must be a positive integer within the allowed limit, or 0 to remove");
    }
    this.repos.carts.setItemQuantity(itemId, quantity);
    this.repos.carts.touch(cartId);
    return this.getCart(customerId, cartId);
  }

  removeItem(customerId, cartId, itemId) {
    this._ownedCart(customerId, cartId);
    const item = this.repos.carts.findItemById(itemId);
    if (!item || item.cart_id !== cartId) {
      throw new CartError("CART_ITEM_NOT_FOUND", `Item ${itemId} not found in cart ${cartId}`, 404);
    }
    this.repos.carts.removeItem(itemId);
    this.repos.carts.touch(cartId);
    return this.getCart(customerId, cartId);
  }

  // Cart itself is kept (still ACTIVE) — only its items are removed.
  clearCart(customerId, cartId) {
    this._ownedCart(customerId, cartId);
    this.repos.carts.clearItems(cartId);
    this.repos.carts.touch(cartId);
    return this.getCart(customerId, cartId);
  }
}
