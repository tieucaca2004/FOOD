import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTestPlatform } from "../helpers/testPlatform.js";

const MERCHANT = "MERCHANT002";

function setup() {
  const platform = buildTestPlatform({ withAtieu: false, genericFixtureMerchants: [MERCHANT] });
  const record = platform.services.menuImport.importText(MERCHANT, "Hủ Tiếu Xào Bò 65k\nHủ Tiếu Xào Gà 60k");
  const approved = platform.services.menuImport.approveImport(MERCHANT, record.id);
  return { platform, importId: approved.id };
}

function productCount(platform) {
  return platform.repos.merchantProducts.listByMerchant(MERCHANT, { includeUnavailable: true }).length;
}

test("BUG-003: a first successful publish adds the draft's products once and marks the import PUBLISHED", () => {
  const { platform, importId } = setup();
  const before = productCount(platform);
  const published = platform.services.menuImport.publishImport(MERCHANT, importId);
  assert.equal(published.status, "PUBLISHED");
  assert.equal(productCount(platform), before + 2);
  assert.equal(platform.services.menu.getMenuStatus(MERCHANT), "PUBLISHED");
});

test("BUG-003: a failure after the products are written rolls back everything, and the retry adds them exactly once", () => {
  const { platform, importId } = setup();
  const before = productCount(platform);
  const originalSetStatus = platform.repos.menuImports.setStatus.bind(platform.repos.menuImports);
  platform.repos.menuImports.setStatus = () => {
    throw new Error("SQLITE_BUSY: database is locked");
  };

  assert.throws(() => platform.services.menuImport.publishImport(MERCHANT, importId), /SQLITE_BUSY/);
  assert.equal(productCount(platform), before);
  assert.equal(platform.services.menuImport.getImport(MERCHANT, importId).status, "APPROVED");

  platform.repos.menuImports.setStatus = originalSetStatus;
  platform.services.menuImport.publishImport(MERCHANT, importId);
  assert.equal(productCount(platform), before + 2);
  const names = platform.repos.merchantProducts.listByMerchant(MERCHANT, { includeUnavailable: true }).map((p) => p.name);
  assert.equal(names.filter((n) => n === "Hủ Tiếu Xào Bò").length, 1);
  assert.equal(names.filter((n) => n === "Hủ Tiếu Xào Gà").length, 1);
});

test("BUG-003: a failure midway through writing products leaves no partial menu, and the retry succeeds", () => {
  const { platform, importId } = setup();
  const before = productCount(platform);
  const originalCreate = platform.services.menu.createProduct.bind(platform.services.menu);
  let calls = 0;
  platform.services.menu.createProduct = (...args) => {
    if (++calls === 2) throw new Error("simulated failure on the second product");
    return originalCreate(...args);
  };

  assert.throws(() => platform.services.menuImport.publishImport(MERCHANT, importId), /second product/);
  assert.equal(productCount(platform), before);

  platform.services.menu.createProduct = originalCreate;
  platform.services.menuImport.publishImport(MERCHANT, importId);
  assert.equal(productCount(platform), before + 2);
});

test("BUG-003: publishing an already-published import is refused and adds nothing", () => {
  const { platform, importId } = setup();
  platform.services.menuImport.publishImport(MERCHANT, importId);
  const after = productCount(platform);
  assert.throws(() => platform.services.menuImport.publishImport(MERCHANT, importId), { code: "ALREADY_PUBLISHED" });
  assert.equal(productCount(platform), after);
});

test("BUG-003: a stale APPROVED read (the race window) still cannot publish twice", () => {
  const { platform, importId } = setup();
  const staleSnapshot = platform.services.menuImport.getImport(MERCHANT, importId);
  platform.services.menuImport.publishImport(MERCHANT, importId);
  const after = productCount(platform);

  // A second caller that read the import before the first one committed.
  const originalGetById = platform.repos.menuImports.getById.bind(platform.repos.menuImports);
  let first = true;
  platform.repos.menuImports.getById = (id) => {
    if (first) {
      first = false;
      return { ...staleSnapshot };
    }
    return originalGetById(id);
  };
  assert.throws(() => platform.services.menuImport.publishImport(MERCHANT, importId), { code: "ALREADY_PUBLISHED" });
  assert.equal(productCount(platform), after);
});
