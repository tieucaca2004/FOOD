import { test } from "node:test";
import assert from "node:assert/strict";
import { MenuService } from "../../services/menuService.js";

function fakeRepos({ categories = [], products = [] } = {}) {
  return {
    merchantCategories: {
      listByMerchant: () => categories,
      create: (merchantId, name, sortOrder) => ({ id: 99, merchant_id: merchantId, name, sort_order: sortOrder }),
    },
    merchantProducts: {
      listByMerchant: () => products,
      findById: (id) => products.find((p) => p.id === id) || null,
      create: (merchantId, product) => ({ id: 100, merchant_id: merchantId, ...product }),
      setAvailability: (id, available) => ({ ...products.find((p) => p.id === id), available }),
      update: (id, patch) => ({ ...products.find((p) => p.id === id), ...patch }),
    },
  };
}

test("getMenu nests products under their category, and separates uncategorized ones", () => {
  const repos = fakeRepos({
    categories: [{ id: 1, name: "Hủ Tiếu Xào" }],
    products: [
      { id: 10, category_id: 1, name: "Hủ Tiếu Xào Bò" },
      { id: 11, category_id: null, name: "Trà Đá" },
    ],
  });
  const menu = new MenuService(repos).getMenu("M001");
  assert.equal(menu.categories.length, 1);
  assert.equal(menu.categories[0].products.length, 1);
  assert.equal(menu.categories[0].products[0].name, "Hủ Tiếu Xào Bò");
  assert.equal(menu.uncategorizedProducts.length, 1);
});

test("addProduct rejects a missing/negative price — never trusts a bad price silently", () => {
  const svc = new MenuService(fakeRepos());
  assert.throws(() => svc.addProduct("M001", { name: "X", sku: "SKU1", price: -5 }), (err) => {
    assert.equal(err.code, "INVALID_PRICE");
    return true;
  });
});

test("addProduct rejects a missing name or sku", () => {
  const svc = new MenuService(fakeRepos());
  assert.throws(() => svc.addProduct("M001", { sku: "SKU1", price: 1000 }), (err) => {
    assert.equal(err.code, "INVALID_PRODUCT");
    return true;
  });
  assert.throws(() => svc.addProduct("M001", { name: "X", price: 1000 }), (err) => {
    assert.equal(err.code, "INVALID_PRODUCT");
    return true;
  });
});

test("setAvailability rejects a nonexistent product instead of silently no-op'ing", () => {
  const svc = new MenuService(fakeRepos({ products: [] }));
  assert.throws(() => svc.setAvailability(999, false), (err) => {
    assert.equal(err.code, "PRODUCT_NOT_FOUND");
    return true;
  });
});

test("updateProduct rejects a negative price patch", () => {
  const svc = new MenuService(fakeRepos({ products: [{ id: 10, name: "X", price: 1000 }] }));
  assert.throws(() => svc.updateProduct(10, { price: -1 }), (err) => {
    assert.equal(err.code, "INVALID_PRICE");
    return true;
  });
});

test("addCategory rejects an empty name", () => {
  const svc = new MenuService(fakeRepos());
  assert.throws(() => svc.addCategory("M001", "   "), (err) => {
    assert.equal(err.code, "INVALID_CATEGORY");
    return true;
  });
});
