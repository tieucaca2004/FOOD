import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTestPlatform } from "../helpers/testPlatform.js";

test("real DB: getMenu returns the seeded fixture product nested under its category", () => {
  const platform = buildTestPlatform({ genericFixtureMerchants: ["MERCHANT002"] });
  const menu = platform.services.menu.getMenu("MERCHANT002");
  assert.equal(menu.categories.length, 1);
  assert.equal(menu.categories[0].name, "Hủ Tiếu Xào");
  assert.equal(menu.categories[0].products.length, 1);
  assert.equal(menu.categories[0].products[0].name, "Hủ Tiếu Xào Hải Sản");
});

test("createProduct + setProductAvailability round-trip through the real repository", () => {
  const platform = buildTestPlatform({ genericFixtureMerchants: ["MERCHANT002"] });
  const category = platform.services.menu.listCategories("MERCHANT002")[0];

  const product = platform.services.menu.createProduct("MERCHANT002", {
    sku: "NEW-DACBIET",
    name: "Hủ Tiếu Xào Đặc Biệt",
    categoryId: category.id,
    price: 90000,
    keywords: ["dac biet"],
  });
  assert.equal(product.available, true);

  const updated = platform.services.menu.setProductAvailability("MERCHANT002", product.id, false);
  assert.equal(updated.available, false);

  const availableOnly = platform.services.menu.listProducts("MERCHANT002");
  assert.equal(availableOnly.some((p) => p.id === product.id), false);

  const all = platform.services.menu.listProducts("MERCHANT002", { includeUnavailable: true });
  assert.equal(all.some((p) => p.id === product.id), true);
});

test("unavailable product is excluded from GenericMerchantAdapter's customer-facing menu but still matches search with availability=false", async () => {
  const platform = buildTestPlatform({ genericFixtureMerchants: ["MERCHANT002"] });
  const products = platform.services.menu.listProducts("MERCHANT002", { includeUnavailable: true });
  const target = products[0];
  platform.services.menu.setProductAvailability("MERCHANT002", target.id, false);

  const adapter = platform.registry.getAdapter("MERCHANT002");
  const menu = await adapter.getMenuSummary();
  assert.equal(menu.items.length, 0); // customer-facing menu never shows it

  const matches = await adapter.searchProducts("hải sản");
  assert.equal(matches.length, 1);
  assert.equal(matches[0].available, false); // but search still reports it exists, honestly marked unavailable
});

test("GenericMerchantAdapter.getMenuSummary reads the merchant name/address through MerchantDataService, not a direct repo call", async () => {
  const platform = buildTestPlatform({ genericFixtureMerchants: ["MERCHANT002"] });
  const adapter = platform.registry.getAdapter("MERCHANT002");
  const menu = await adapter.getMenuSummary();
  assert.equal(menu.name, "Merchant 002 (Test Fixture)");
  assert.equal(menu.address, "Nha Trang, Khánh Hòa");
});

test("Menu/Category/Product changes for MERCHANT002 never affect MERCHANT003's own menu (tenant isolation)", () => {
  const platform = buildTestPlatform({ genericFixtureMerchants: ["MERCHANT002", "MERCHANT003"] });
  const cat2 = platform.services.menu.listCategories("MERCHANT002")[0];
  platform.services.menu.createProduct("MERCHANT002", { sku: "ISO-TEST", name: "Món Riêng M2", categoryId: cat2.id, price: 1000 });

  const m3Products = platform.services.menu.listProducts("MERCHANT003", { includeUnavailable: true });
  assert.equal(m3Products.some((p) => p.name === "Món Riêng M2"), false);
});

// --- Menu lifecycle (DRAFT -> PUBLISHED -> ARCHIVED) against the real DB ---

test("menu lifecycle: createMenu starts DRAFT (hidden), publishMenu makes it visible in Discovery, archiveMenu hides it again", async () => {
  const platform = buildTestPlatform({ genericFixtureMerchants: ["MERCHANT002"] });

  // MERCHANT002 has no explicit menu row yet -> legacy-visible by default.
  let result = await platform.agentSearch.searchMerchants("hải sản");
  assert.ok(result.organic.some((c) => c.merchant.merchant_id === "MERCHANT002"));

  platform.services.menu.createMenu("MERCHANT002"); // DRAFT
  result = await platform.agentSearch.searchMerchants("hải sản");
  assert.equal(result.organic.some((c) => c.merchant.merchant_id === "MERCHANT002"), false);

  platform.services.menu.publishMenu("MERCHANT002");
  result = await platform.agentSearch.searchMerchants("hải sản");
  assert.ok(result.organic.some((c) => c.merchant.merchant_id === "MERCHANT002"));

  platform.services.menu.archiveMenu("MERCHANT002");
  result = await platform.agentSearch.searchMerchants("hải sản");
  assert.equal(result.organic.some((c) => c.merchant.merchant_id === "MERCHANT002"), false);

  // ATIEU001 (a different merchant entirely) is unaffected by MERCHANT002's lifecycle.
  const atieuResult = await platform.agentSearch.searchMerchants("hủ tiếu xào bò");
  assert.ok(atieuResult.organic.some((c) => c.merchant.merchant_id === "ATIEU001"));
});

test("archived menu is also excluded from that merchant's own searchProducts (not just global discovery)", async () => {
  const platform = buildTestPlatform({ genericFixtureMerchants: ["MERCHANT002"] });
  platform.services.menu.publishMenu("MERCHANT002");
  platform.services.menu.archiveMenu("MERCHANT002");

  const adapter = platform.registry.getAdapter("MERCHANT002");
  const matches = await adapter.searchProducts("hải sản");
  assert.equal(matches.length, 0);
});

// --- Tenant isolation for the new mutation methods, against the real DB ---

test("updateCategory/deleteCategory reject a MERCHANT003 attempt on MERCHANT002's category", () => {
  const platform = buildTestPlatform({ genericFixtureMerchants: ["MERCHANT002", "MERCHANT003"] });
  const cat2 = platform.services.menu.listCategories("MERCHANT002")[0];

  assert.throws(() => platform.services.menu.updateCategory("MERCHANT003", cat2.id, { name: "Hijacked" }), (err) => {
    assert.equal(err.code, "CATEGORY_NOT_FOUND");
    return true;
  });
  assert.throws(() => platform.services.menu.deleteCategory("MERCHANT003", cat2.id), (err) => {
    assert.equal(err.code, "CATEGORY_NOT_FOUND");
    return true;
  });

  // Category is untouched.
  assert.equal(platform.services.menu.getCategory("MERCHANT002", cat2.id).name, cat2.name);
});

test("updateProduct/deleteProduct/setProductAvailability reject a MERCHANT003 attempt on MERCHANT002's product", () => {
  const platform = buildTestPlatform({ genericFixtureMerchants: ["MERCHANT002", "MERCHANT003"] });
  const product2 = platform.services.menu.listProducts("MERCHANT002", { includeUnavailable: true })[0];

  assert.throws(() => platform.services.menu.updateProduct("MERCHANT003", product2.id, { price: 1 }), (err) => {
    assert.equal(err.code, "PRODUCT_NOT_FOUND");
    return true;
  });
  assert.throws(() => platform.services.menu.deleteProduct("MERCHANT003", product2.id), (err) => {
    assert.equal(err.code, "PRODUCT_NOT_FOUND");
    return true;
  });
  assert.throws(() => platform.services.menu.setProductAvailability("MERCHANT003", product2.id, false), (err) => {
    assert.equal(err.code, "PRODUCT_NOT_FOUND");
    return true;
  });

  // Product untouched — still available, original price.
  const stillThere = platform.services.menu.getProduct("MERCHANT002", product2.id);
  assert.equal(stillThere.price, product2.price);
  assert.equal(stillThere.available, true);
});

test("updateMenu/publishMenu/archiveMenu are structurally merchant-scoped — MERCHANT003 has no way to address MERCHANT002's menu", () => {
  const platform = buildTestPlatform({ genericFixtureMerchants: ["MERCHANT002", "MERCHANT003"] });
  platform.services.menu.publishMenu("MERCHANT002");

  // "Calling as MERCHANT003" only ever touches MERCHANT003's own row —
  // there is no menu-id parameter to spoof, so this necessarily creates/
  // affects MERCHANT003's own menu, never MERCHANT002's.
  platform.services.menu.publishMenu("MERCHANT003");
  platform.services.menu.archiveMenu("MERCHANT003");

  assert.equal(platform.services.menu.getMenuStatus("MERCHANT002"), "PUBLISHED"); // untouched
  assert.equal(platform.services.menu.getMenuStatus("MERCHANT003"), "ARCHIVED");
});

test("deleteProduct actually removes the row (real DB), and deleteCategory refuses while products remain", () => {
  const platform = buildTestPlatform({ genericFixtureMerchants: ["MERCHANT002"] });
  const category = platform.services.menu.listCategories("MERCHANT002")[0];
  const product = platform.services.menu.listProducts("MERCHANT002", { includeUnavailable: true })[0];

  assert.throws(() => platform.services.menu.deleteCategory("MERCHANT002", category.id), (err) => {
    assert.equal(err.code, "CATEGORY_NOT_EMPTY");
    return true;
  });

  platform.services.menu.deleteProduct("MERCHANT002", product.id);
  assert.throws(() => platform.services.menu.getProduct("MERCHANT002", product.id), (err) => {
    assert.equal(err.code, "PRODUCT_NOT_FOUND");
    return true;
  });

  // Now the category is empty and can be deleted.
  const result = platform.services.menu.deleteCategory("MERCHANT002", category.id);
  assert.equal(result.deleted, true);
  assert.equal(platform.services.menu.listCategories("MERCHANT002").length, 0);
});
