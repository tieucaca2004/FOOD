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

test("addProduct + setAvailability round-trip through the real repository", () => {
  const platform = buildTestPlatform({ genericFixtureMerchants: ["MERCHANT002"] });
  const category = platform.services.menu.listCategories("MERCHANT002")[0];

  const product = platform.services.menu.addProduct("MERCHANT002", {
    sku: "NEW-DACBIET",
    name: "Hủ Tiếu Xào Đặc Biệt",
    categoryId: category.id,
    price: 90000,
    keywords: ["dac biet"],
  });
  assert.equal(product.available, true);

  const updated = platform.services.menu.setAvailability(product.id, false);
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
  platform.services.menu.setAvailability(target.id, false);

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
  platform.services.menu.addProduct("MERCHANT002", { sku: "ISO-TEST", name: "Món Riêng M2", categoryId: cat2.id, price: 1000 });

  const m3Products = platform.services.menu.listProducts("MERCHANT003", { includeUnavailable: true });
  assert.equal(m3Products.some((p) => p.name === "Món Riêng M2"), false);
});
