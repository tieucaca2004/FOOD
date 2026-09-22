import { test } from "node:test";
import assert from "node:assert/strict";
import { MenuService } from "../../services/menuService.js";

function fakeRepos({ categories = [], products = [], menus = [] } = {}) {
  const menuStore = new Map(menus.map((m) => [m.merchant_id, m]));
  let nextId = 1000;
  return {
    merchantMenus: {
      getByMerchant: (merchantId) => menuStore.get(merchantId) || undefined,
      create: (merchantId, { name = null, status = "DRAFT" } = {}) => {
        const row = { id: nextId++, merchant_id: merchantId, name, status };
        menuStore.set(merchantId, row);
        return row;
      },
      updateStatus: (merchantId, status) => {
        const row = menuStore.get(merchantId);
        row.status = status;
        return row;
      },
      update: (merchantId, patch) => {
        const row = menuStore.get(merchantId);
        if (patch.name !== undefined) row.name = patch.name;
        if (patch.status !== undefined) row.status = patch.status;
        return row;
      },
    },
    merchantCategories: {
      listByMerchant: (merchantId) => categories.filter((c) => c.merchant_id === merchantId),
      getById: (id) => categories.find((c) => c.id === id) || null,
      create: (merchantId, name, sortOrder) => ({ id: 99, merchant_id: merchantId, name, sort_order: sortOrder }),
      update: (id, patch) => ({ ...categories.find((c) => c.id === id), ...patch }),
      delete: () => {},
    },
    merchantProducts: {
      listByMerchant: (merchantId) => products.filter((p) => p.merchant_id === merchantId),
      findById: (id) => products.find((p) => p.id === id) || null,
      create: (merchantId, product) => ({ id: 100, merchant_id: merchantId, ...product }),
      setAvailability: (id, available) => ({ ...products.find((p) => p.id === id), available }),
      update: (id, patch) => ({ ...products.find((p) => p.id === id), ...patch }),
      delete: () => {},
    },
  };
}

test("getMenu nests products under their category, and separates uncategorized ones", () => {
  const repos = fakeRepos({
    categories: [{ id: 1, merchant_id: "M001", name: "Hủ Tiếu Xào" }],
    products: [
      { id: 10, merchant_id: "M001", category_id: 1, name: "Hủ Tiếu Xào Bò" },
      { id: 11, merchant_id: "M001", category_id: null, name: "Trà Đá" },
    ],
  });
  const menu = new MenuService(repos).getMenu("M001");
  assert.equal(menu.status, null); // no explicit menu row -> legacy/implicit
  assert.equal(menu.categories.length, 1);
  assert.equal(menu.categories[0].products.length, 1);
  assert.equal(menu.categories[0].products[0].name, "Hủ Tiếu Xào Bò");
  assert.equal(menu.uncategorizedProducts.length, 1);
});

test("createProduct rejects a missing/negative price — never trusts a bad price silently", () => {
  const svc = new MenuService(fakeRepos());
  assert.throws(() => svc.createProduct("M001", { name: "X", sku: "SKU1", price: -5 }), (err) => {
    assert.equal(err.code, "INVALID_PRICE");
    return true;
  });
});

test("createProduct rejects a missing name or sku", () => {
  const svc = new MenuService(fakeRepos());
  assert.throws(() => svc.createProduct("M001", { sku: "SKU1", price: 1000 }), (err) => {
    assert.equal(err.code, "INVALID_PRODUCT");
    return true;
  });
  assert.throws(() => svc.createProduct("M001", { name: "X", price: 1000 }), (err) => {
    assert.equal(err.code, "INVALID_PRODUCT");
    return true;
  });
});

test("setProductAvailability rejects a nonexistent product instead of silently no-op'ing", () => {
  const svc = new MenuService(fakeRepos({ products: [] }));
  assert.throws(() => svc.setProductAvailability("M001", 999, false), (err) => {
    assert.equal(err.code, "PRODUCT_NOT_FOUND");
    return true;
  });
});

test("updateProduct rejects a negative price patch", () => {
  const svc = new MenuService(fakeRepos({ products: [{ id: 10, merchant_id: "M001", name: "X", price: 1000 }] }));
  assert.throws(() => svc.updateProduct("M001", 10, { price: -1 }), (err) => {
    assert.equal(err.code, "INVALID_PRICE");
    return true;
  });
});

test("createCategory rejects an empty name", () => {
  const svc = new MenuService(fakeRepos());
  assert.throws(() => svc.createCategory("M001", "   "), (err) => {
    assert.equal(err.code, "INVALID_CATEGORY");
    return true;
  });
});

// --- Newly added contract methods -----------------------------------------

test("createMenu is idempotent — calling twice returns the same DRAFT row", () => {
  const svc = new MenuService(fakeRepos());
  const first = svc.createMenu("M001");
  const second = svc.createMenu("M001");
  assert.equal(first.id, second.id);
  assert.equal(first.status, "DRAFT");
});

test("updateMenu throws MENU_NOT_FOUND if createMenu was never called", () => {
  const svc = new MenuService(fakeRepos());
  assert.throws(() => svc.updateMenu("M001", { name: "New name" }), (err) => {
    assert.equal(err.code, "MENU_NOT_FOUND");
    return true;
  });
});

test("updateMenu changes the menu's name once it exists", () => {
  const svc = new MenuService(fakeRepos());
  svc.createMenu("M001");
  const updated = svc.updateMenu("M001", { name: "Thực đơn cuối tuần" });
  assert.equal(updated.name, "Thực đơn cuối tuần");
});

test("publishMenu auto-creates the menu if missing and sets status PUBLISHED", () => {
  const svc = new MenuService(fakeRepos());
  const published = svc.publishMenu("M001");
  assert.equal(published.status, "PUBLISHED");
});

test("archiveMenu throws MENU_NOT_FOUND for a merchant that never had a menu", () => {
  const svc = new MenuService(fakeRepos());
  assert.throws(() => svc.archiveMenu("M001"), (err) => {
    assert.equal(err.code, "MENU_NOT_FOUND");
    return true;
  });
});

test("archiveMenu sets status ARCHIVED on an existing menu", () => {
  const svc = new MenuService(fakeRepos());
  svc.publishMenu("M001");
  const archived = svc.archiveMenu("M001");
  assert.equal(archived.status, "ARCHIVED");
});

test("isMenuVisible: true with no menu row (legacy), true when PUBLISHED, false for DRAFT/ARCHIVED", () => {
  const svc = new MenuService(fakeRepos());
  assert.equal(svc.isMenuVisible("M001"), true); // no row yet

  svc.createMenu("M002"); // DRAFT
  assert.equal(svc.isMenuVisible("M002"), false);

  svc.publishMenu("M002");
  assert.equal(svc.isMenuVisible("M002"), true);

  svc.archiveMenu("M002");
  assert.equal(svc.isMenuVisible("M002"), false);
});

test("getCategory/updateCategory/deleteCategory reject a category belonging to a different merchant", () => {
  const repos = fakeRepos({ categories: [{ id: 5, merchant_id: "MERCHANT002", name: "Món chính" }] });
  const svc = new MenuService(repos);

  assert.throws(() => svc.getCategory("MERCHANT003", 5), (err) => {
    assert.equal(err.code, "CATEGORY_NOT_FOUND");
    return true;
  });
  assert.throws(() => svc.updateCategory("MERCHANT003", 5, { name: "Hijack" }), (err) => {
    assert.equal(err.code, "CATEGORY_NOT_FOUND");
    return true;
  });
  assert.throws(() => svc.deleteCategory("MERCHANT003", 5), (err) => {
    assert.equal(err.code, "CATEGORY_NOT_FOUND");
    return true;
  });

  // But the real owner can.
  const updated = svc.updateCategory("MERCHANT002", 5, { name: "Món chính (sửa)" });
  assert.equal(updated.name, "Món chính (sửa)");
});

test("deleteCategory refuses to delete a category that still has products", () => {
  const repos = fakeRepos({
    categories: [{ id: 5, merchant_id: "M001", name: "Món chính" }],
    products: [{ id: 10, merchant_id: "M001", category_id: 5, name: "X" }],
  });
  const svc = new MenuService(repos);
  assert.throws(() => svc.deleteCategory("M001", 5), (err) => {
    assert.equal(err.code, "CATEGORY_NOT_EMPTY");
    return true;
  });
});

test("getProduct/updateProduct/deleteProduct/setProductAvailability reject a product belonging to a different merchant", () => {
  const repos = fakeRepos({ products: [{ id: 20, merchant_id: "MERCHANT002", name: "Hủ Tiếu Xào Bò", price: 65000 }] });
  const svc = new MenuService(repos);

  assert.throws(() => svc.getProduct("MERCHANT003", 20), (err) => assert.equal(err.code, "PRODUCT_NOT_FOUND") || true);
  assert.throws(() => svc.updateProduct("MERCHANT003", 20, { price: 1 }), (err) => assert.equal(err.code, "PRODUCT_NOT_FOUND") || true);
  assert.throws(() => svc.deleteProduct("MERCHANT003", 20), (err) => assert.equal(err.code, "PRODUCT_NOT_FOUND") || true);
  assert.throws(() => svc.setProductAvailability("MERCHANT003", 20, false), (err) => assert.equal(err.code, "PRODUCT_NOT_FOUND") || true);
});

test("createProduct rejects filing under another merchant's category", () => {
  const repos = fakeRepos({ categories: [{ id: 5, merchant_id: "MERCHANT002", name: "Món chính" }] });
  const svc = new MenuService(repos);
  assert.throws(() => svc.createProduct("MERCHANT003", { name: "X", sku: "SKU1", price: 1000, categoryId: 5 }), (err) => {
    assert.equal(err.code, "CATEGORY_NOT_FOUND");
    return true;
  });
});
