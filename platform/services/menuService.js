/**
 * Generic Menu Engine (Phase 3): the canonical read/write layer for a
 * "generic" (data-driven, no dedicated code module) merchant's
 * Menu -> Category -> Product data. Same role as MerchantDataService for
 * merchant records — GenericMerchantAdapter, admin API, and any future
 * caller should go through this, never call
 * merchantProducts/merchantCategories repositories directly (spec §46).
 *
 * A Tiểu is unaffected: it has its own dedicated menu engine
 * (src/services/menuService.js) and never touches this class.
 */
export class MenuService {
  constructor(repos) {
    this.repos = repos;
  }

  // Nested Menu -> Category -> Product view, matching spec §29's model.
  // Unavailable products are included so a merchant admin viewing their
  // own menu can see everything; customer-facing callers (search/menu
  // display) should pass includeUnavailable: false.
  getMenu(merchantId, { includeUnavailable = true } = {}) {
    const categories = this.repos.merchantCategories.listByMerchant(merchantId);
    const products = this.repos.merchantProducts.listByMerchant(merchantId, { includeUnavailable });

    const byCategory = new Map(categories.map((c) => [c.id, { ...c, products: [] }]));
    const uncategorized = [];
    for (const product of products) {
      const bucket = byCategory.get(product.category_id);
      if (bucket) bucket.products.push(product);
      else uncategorized.push(product);
    }

    return {
      merchantId,
      categories: [...byCategory.values()],
      uncategorizedProducts: uncategorized,
    };
  }

  listCategories(merchantId) {
    return this.repos.merchantCategories.listByMerchant(merchantId);
  }

  listProducts(merchantId, { includeUnavailable = false } = {}) {
    return this.repos.merchantProducts.listByMerchant(merchantId, { includeUnavailable });
  }

  getProduct(productId) {
    return this.repos.merchantProducts.findById(productId);
  }

  addCategory(merchantId, name, sortOrder = 0) {
    if (!name || !name.trim()) {
      const err = new Error("Category name is required");
      err.code = "INVALID_CATEGORY";
      throw err;
    }
    return this.repos.merchantCategories.create(merchantId, name.trim(), sortOrder);
  }

  // Server-side validation only — never trusts a client/AI-supplied price
  // of 0 or negative, same rule as A Tiểu's own cart/order engine.
  addProduct(merchantId, product) {
    if (!product.name || !product.name.trim()) {
      const err = new Error("Product name is required");
      err.code = "INVALID_PRODUCT";
      throw err;
    }
    if (!Number.isInteger(product.price) || product.price < 0) {
      const err = new Error("Product price must be a non-negative integer (VND)");
      err.code = "INVALID_PRICE";
      throw err;
    }
    if (!product.sku || !product.sku.trim()) {
      const err = new Error("Product sku is required");
      err.code = "INVALID_PRODUCT";
      throw err;
    }
    return this.repos.merchantProducts.create(merchantId, product);
  }

  // Dedicated method for the one admin action spec §44 calls out
  // explicitly ("change availability") — separate from a general update
  // so toggling stock is a single, auditable, minimal write.
  setAvailability(productId, available) {
    const product = this.repos.merchantProducts.findById(productId);
    if (!product) {
      const err = new Error(`Product ${productId} not found`);
      err.code = "PRODUCT_NOT_FOUND";
      throw err;
    }
    return this.repos.merchantProducts.setAvailability(productId, available);
  }

  updateProduct(productId, patch) {
    const product = this.repos.merchantProducts.findById(productId);
    if (!product) {
      const err = new Error(`Product ${productId} not found`);
      err.code = "PRODUCT_NOT_FOUND";
      throw err;
    }
    if (patch.price !== undefined && (!Number.isInteger(patch.price) || patch.price < 0)) {
      const err = new Error("Product price must be a non-negative integer (VND)");
      err.code = "INVALID_PRICE";
      throw err;
    }
    return this.repos.merchantProducts.update(productId, patch);
  }
}
