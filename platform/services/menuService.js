/**
 * Generic Menu Engine (Phase 3): the canonical read/write layer for a
 * "generic" (data-driven, no dedicated code module) merchant's
 * Menu -> Category -> Product data. Same role as MerchantDataService for
 * merchant records — GenericMerchantAdapter, admin API, and any future
 * caller should go through this, never call merchantProducts/
 * merchantCategories/merchantMenus repositories directly (spec §46).
 *
 * A Tiểu is unaffected: it has its own dedicated menu engine
 * (src/services/menuService.js) and never touches this class.
 *
 * Tenant isolation: every mutation on a category/product/menu takes the
 * caller's own merchantId and verifies the resource actually belongs to
 * it before touching anything — MERCHANT002 can never update/delete
 * MERCHANT003's category/product/menu, because there is no code path that
 * addresses a resource by id alone. The menu entity itself has no
 * separate id at all (keyed 1:1 by merchant_id), so it's structurally
 * impossible to address another merchant's menu.
 */

function notFound(code, message) {
  const err = new Error(message);
  err.code = code;
  err.status = 404;
  return err;
}

function invalid(code, message) {
  const err = new Error(message);
  err.code = code;
  err.status = 400;
  return err;
}

export class MenuService {
  constructor(repos) {
    this.repos = repos;
  }

  // ---------------------------------------------------------------------
  // Menu lifecycle (DRAFT -> PUBLISHED -> ARCHIVED). A merchant with no
  // menu row at all (never called createMenu/publishMenu) is treated as
  // implicitly visible — this is the pre-existing behavior, preserved so
  // merchants/fixtures created before this lifecycle existed keep working.
  // ---------------------------------------------------------------------

  createMenu(merchantId, { name } = {}) {
    const existing = this.repos.merchantMenus.getByMerchant(merchantId);
    if (existing) return existing; // idempotent
    return this.repos.merchantMenus.create(merchantId, { name });
  }

  // Nested Menu -> Category -> Product view, matching spec §29's model,
  // plus the lifecycle status (null when no menu row exists yet — see
  // class doc). This is the full/admin view — includes unavailable
  // products and is unaffected by DRAFT/ARCHIVED status; only the
  // customer-facing path (GenericMerchantAdapter) hides non-PUBLISHED menus.
  getMenu(merchantId, { includeUnavailable = true } = {}) {
    const menuEntity = this.repos.merchantMenus.getByMerchant(merchantId);
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
      status: menuEntity ? menuEntity.status : null,
      categories: [...byCategory.values()],
      uncategorizedProducts: uncategorized,
    };
  }

  // Lightweight status-only read — used by GenericMerchantAdapter to
  // decide customer-facing visibility without loading the full menu.
  getMenuStatus(merchantId) {
    const menu = this.repos.merchantMenus.getByMerchant(merchantId);
    return menu ? menu.status : null;
  }

  // Customer-facing gate: PUBLISHED (or no menu row at all — legacy
  // merchants that predate this lifecycle) is visible; DRAFT/ARCHIVED are not.
  isMenuVisible(merchantId) {
    const status = this.getMenuStatus(merchantId);
    return status === null || status === "PUBLISHED";
  }

  updateMenu(merchantId, patch) {
    const menu = this.repos.merchantMenus.getByMerchant(merchantId);
    if (!menu) throw notFound("MENU_NOT_FOUND", `No menu record for merchant ${merchantId} — call createMenu first`);
    if (patch.name !== undefined && typeof patch.name !== "string") {
      throw invalid("INVALID_MENU", "Menu name must be a string");
    }
    return this.repos.merchantMenus.update(merchantId, patch);
  }

  // Auto-creates the menu row if this is the first publish — publishing
  // implies "make visible", so requiring a separate createMenu() call
  // first would just be friction with no safety benefit.
  publishMenu(merchantId) {
    if (!this.repos.merchantMenus.getByMerchant(merchantId)) {
      this.repos.merchantMenus.create(merchantId);
    }
    return this.repos.merchantMenus.updateStatus(merchantId, "PUBLISHED");
  }

  archiveMenu(merchantId) {
    const menu = this.repos.merchantMenus.getByMerchant(merchantId);
    if (!menu) throw notFound("MENU_NOT_FOUND", `No menu record for merchant ${merchantId} to archive`);
    return this.repos.merchantMenus.updateStatus(merchantId, "ARCHIVED");
  }

  // ---------------------------------------------------------------------
  // Category
  // ---------------------------------------------------------------------

  listCategories(merchantId) {
    return this.repos.merchantCategories.listByMerchant(merchantId);
  }

  // Ownership check shared by get/update/delete — throws the same
  // CATEGORY_NOT_FOUND whether the id doesn't exist or belongs to a
  // different merchant, so a caller can never distinguish "not yours"
  // from "doesn't exist" (avoids leaking cross-tenant existence).
  _ownedCategory(merchantId, categoryId) {
    const category = this.repos.merchantCategories.getById(categoryId);
    if (!category || category.merchant_id !== merchantId) {
      throw notFound("CATEGORY_NOT_FOUND", `Category ${categoryId} not found for merchant ${merchantId}`);
    }
    return category;
  }

  createCategory(merchantId, name, sortOrder = 0) {
    if (!name || !name.trim()) throw invalid("INVALID_CATEGORY", "Category name is required");
    return this.repos.merchantCategories.create(merchantId, name.trim(), sortOrder);
  }

  getCategory(merchantId, categoryId) {
    return this._ownedCategory(merchantId, categoryId);
  }

  updateCategory(merchantId, categoryId, patch) {
    this._ownedCategory(merchantId, categoryId);
    if (patch.name !== undefined && !patch.name.trim()) {
      throw invalid("INVALID_CATEGORY", "Category name cannot be empty");
    }
    return this.repos.merchantCategories.update(categoryId, patch);
  }

  // Refuses to delete a category that still has products — an explicit,
  // safe default rather than silently orphaning or cascade-deleting them.
  deleteCategory(merchantId, categoryId) {
    this._ownedCategory(merchantId, categoryId);
    const stillHasProducts = this.repos.merchantProducts
      .listByMerchant(merchantId, { includeUnavailable: true })
      .some((p) => p.category_id === categoryId);
    if (stillHasProducts) {
      throw invalid("CATEGORY_NOT_EMPTY", "Move or delete this category's products before deleting it");
    }
    this.repos.merchantCategories.delete(categoryId);
    return { deleted: true };
  }

  // ---------------------------------------------------------------------
  // Product
  // ---------------------------------------------------------------------

  listProducts(merchantId, { includeUnavailable = false } = {}) {
    return this.repos.merchantProducts.listByMerchant(merchantId, { includeUnavailable });
  }

  _ownedProduct(merchantId, productId) {
    const product = this.repos.merchantProducts.findById(productId);
    if (!product || product.merchant_id !== merchantId) {
      throw notFound("PRODUCT_NOT_FOUND", `Product ${productId} not found for merchant ${merchantId}`);
    }
    return product;
  }

  getProduct(merchantId, productId) {
    return this._ownedProduct(merchantId, productId);
  }

  // Server-side validation only — never trusts a client/AI-supplied price
  // of 0 or negative, same rule as A Tiểu's own cart/order engine.
  createProduct(merchantId, product) {
    if (!product.name || !product.name.trim()) throw invalid("INVALID_PRODUCT", "Product name is required");
    if (!product.sku || !product.sku.trim()) throw invalid("INVALID_PRODUCT", "Product sku is required");
    if (!Number.isInteger(product.price) || product.price < 0) {
      throw invalid("INVALID_PRICE", "Product price must be a non-negative integer (VND)");
    }
    if (product.categoryId !== undefined && product.categoryId !== null) {
      this._ownedCategory(merchantId, product.categoryId); // can't file a product under another merchant's category
    }
    return this.repos.merchantProducts.create(merchantId, product);
  }

  updateProduct(merchantId, productId, patch) {
    this._ownedProduct(merchantId, productId);
    if (patch.price !== undefined && (!Number.isInteger(patch.price) || patch.price < 0)) {
      throw invalid("INVALID_PRICE", "Product price must be a non-negative integer (VND)");
    }
    if (patch.categoryId !== undefined && patch.categoryId !== null) {
      this._ownedCategory(merchantId, patch.categoryId);
    }
    return this.repos.merchantProducts.update(productId, patch);
  }

  deleteProduct(merchantId, productId) {
    this._ownedProduct(merchantId, productId);
    this.repos.merchantProducts.delete(productId);
    return { deleted: true };
  }

  // Dedicated method for the one admin action spec §44 calls out
  // explicitly ("change availability") — separate from a general update
  // so toggling stock is a single, auditable, minimal write.
  setProductAvailability(merchantId, productId, available) {
    this._ownedProduct(merchantId, productId);
    return this.repos.merchantProducts.setAvailability(productId, available);
  }

  // ---------------------------------------------------------------------
  // Menu Import (Phase 4) entry point — the ONLY way an approved import
  // draft becomes real categories/products + a PUBLISHED menu. Called by
  // MenuImportService.publishImport(); nothing else ever writes published
  // menu tables from a draft. Wrapped in one DB transaction (spec §22) —
  // either the whole draft applies and the menu publishes, or nothing
  // changes at all.
  // ---------------------------------------------------------------------
  applyPublishedDraft(merchantId, draft) {
    const db = this.repos.merchantMenus.db; // same connection every repo shares
    const tx = db.transaction(() => {
      const existingCategories = this.repos.merchantCategories.listByMerchant(merchantId);
      const existingProducts = this.repos.merchantProducts.listByMerchant(merchantId, { includeUnavailable: true });
      const usedSkus = new Set(existingProducts.map((p) => p.sku));

      for (const draftCategory of draft.categories || []) {
        let categoryRow = draftCategory.name
          ? existingCategories.find((c) => c.name === draftCategory.name)
          : null;
        if (draftCategory.name && !categoryRow) {
          categoryRow = this.createCategory(merchantId, draftCategory.name);
          existingCategories.push(categoryRow);
        }

        for (const product of draftCategory.products || []) {
          // Defensive re-check — approveImport() should already guarantee
          // this, but publish never trusts a draft blindly.
          if (product.needs_review || product.price == null) continue;

          const sku = this._generateUniqueSku(product.name, usedSkus);
          usedSkus.add(sku);
          this.createProduct(merchantId, {
            sku,
            name: product.name,
            categoryId: categoryRow ? categoryRow.id : null,
            description: product.description ?? null,
            price: product.price,
            available: product.available !== false,
            keywords: product.keywords || [],
          });
        }
      }

      this.publishMenu(merchantId);
    });
    tx();
    return this.getMenu(merchantId);
  }

  _generateUniqueSku(name, usedSkus) {
    const base =
      (name || "item")
        .toString()
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .replace(/đ/gi, "d")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40) || "item";
    let candidate = base;
    let suffix = 1;
    while (usedSkus.has(candidate)) {
      candidate = `${base}-${suffix++}`;
    }
    return candidate;
  }
}
