import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTestPlatform } from "../helpers/testPlatform.js";

const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);

function twoMerchants() {
  return buildTestPlatform({ withAtieu: false, genericFixtureMerchants: ["MERCHANT002", "MERCHANT003"] });
}

// --- TEXT --------------------------------------------------------------

test("importText creates a DRAFT import when everything parses cleanly", () => {
  const platform = twoMerchants();
  const record = platform.services.menuImport.importText("MERCHANT002", "Hủ Tiếu Xào Bò 65k");
  assert.equal(record.status, "DRAFT");
  assert.equal(record.source_type, "TEXT");
  assert.equal(record.draft.categories[0].products[0].price, 65000);
});

test("importText creates REVIEW_REQUIRED when a price is missing", () => {
  const platform = twoMerchants();
  const record = platform.services.menuImport.importText("MERCHANT002", "Mì bò đặc biệt");
  assert.equal(record.status, "REVIEW_REQUIRED");
});

// --- IMAGE: 8, 9, 10 -----------------------------------------------------

test("8. valid image import succeeds through validation + storage", async () => {
  const platform = twoMerchants();
  platform.visionProvider.result = { categories: [{ name: "Hủ Tiếu Xào", products: [{ name: "Hủ Tiếu Xào Bò", price: 65000, confidence: 0.95 }] }] };
  const record = await platform.services.menuImport.importImage("MERCHANT002", { buffer: JPEG_MAGIC, mimeType: "image/jpeg" });
  assert.equal(record.source_type, "IMAGE");
  assert.equal(record.status, "DRAFT");
  assert.ok(record.source_reference); // stored, opaque reference
});

test("9. invalid file type is rejected before any import record is created", async () => {
  const platform = twoMerchants();
  await assert.rejects(
    () => platform.services.menuImport.importImage("MERCHANT002", { buffer: JPEG_MAGIC, mimeType: "image/gif" }),
    (err) => {
      assert.equal(err.code, "UNSUPPORTED_FILE");
      return true;
    }
  );
  assert.equal(platform.services.menuImport.listImports("MERCHANT002").length, 0);
});

test("10. oversized image is rejected as FILE_TOO_LARGE", async () => {
  const platform = twoMerchants();
  const big = Buffer.concat([JPEG_MAGIC, Buffer.alloc(20 * 1024 * 1024)]);
  await assert.rejects(
    () => platform.services.menuImport.importImage("MERCHANT002", { buffer: big, mimeType: "image/jpeg" }),
    (err) => {
      assert.equal(err.code, "FILE_TOO_LARGE");
      return true;
    }
  );
});

// --- IMAGE: 11-15 --------------------------------------------------------

test("11. OCR success produces a draft with the provider's structured output, unmodified where valid", async () => {
  const platform = twoMerchants();
  platform.visionProvider.result = {
    categories: [{ name: "Hủ Tiếu Xào", products: [{ name: "Hủ Tiếu Xào Hải Sản", price: 75000, confidence: 0.98 }] }],
  };
  const record = await platform.services.menuImport.importImage("MERCHANT002", { buffer: JPEG_MAGIC, mimeType: "image/jpeg" });
  assert.equal(record.draft.categories[0].products[0].name, "Hủ Tiếu Xào Hải Sản");
  assert.equal(record.draft.categories[0].products[0].price, 75000);
  assert.equal(record.draft.categories[0].products[0].confidence, 0.98);
});

test("12. OCR/vision provider failure marks the import FAILED with a real error, not a crash", async () => {
  const platform = twoMerchants();
  const boom = new Error("upstream timeout");
  boom.code = "VISION_PROVIDER_ERROR";
  platform.visionProvider.failWith = boom;
  const record = await platform.services.menuImport.importImage("MERCHANT002", { buffer: JPEG_MAGIC, mimeType: "image/jpeg" });
  assert.equal(record.status, "FAILED");
  assert.match(record.error_message, /VISION_PROVIDER_ERROR/);
});

test("13. low-confidence field forces needs_review, never silently auto-published", async () => {
  const platform = twoMerchants();
  platform.visionProvider.result = {
    categories: [{ name: "Hủ Tiếu Xào", products: [{ name: "Món mờ chữ", price: 60000, confidence: 0.3 }] }],
  };
  const record = await platform.services.menuImport.importImage("MERCHANT002", { buffer: JPEG_MAGIC, mimeType: "image/jpeg" });
  assert.equal(record.status, "REVIEW_REQUIRED");
  assert.equal(record.draft.categories[0].products[0].needs_review, true);
});

test("14. missing price from OCR output sets price null + needs_review, never guessed", async () => {
  const platform = twoMerchants();
  platform.visionProvider.result = {
    categories: [{ name: "Hủ Tiếu Xào", products: [{ name: "Món không giá", price: null, confidence: 0.9 }] }],
  };
  const record = await platform.services.menuImport.importImage("MERCHANT002", { buffer: JPEG_MAGIC, mimeType: "image/jpeg" });
  const product = record.draft.categories[0].products[0];
  assert.equal(product.price, null);
  assert.equal(product.needs_review, true);
});

test("15. vision provider not configured (Null default) fails the import honestly", async () => {
  const platform = twoMerchants();
  platform.visionProvider.failWith = Object.assign(new Error("No menu vision provider configured"), { code: "VISION_PROVIDER_NOT_CONFIGURED" });
  const record = await platform.services.menuImport.importImage("MERCHANT002", { buffer: JPEG_MAGIC, mimeType: "image/jpeg" });
  assert.equal(record.status, "FAILED");
  assert.match(record.error_message, /VISION_PROVIDER_NOT_CONFIGURED/);
});

// --- DRAFT: 16-19 ----------------------------------------------------------

test("16. draft creation persists categories/products retrievable via getImport", () => {
  const platform = twoMerchants();
  const created = platform.services.menuImport.importText("MERCHANT002", "Hủ Tiếu Xào Bò 65k");
  const fetched = platform.services.menuImport.getImport("MERCHANT002", created.id);
  assert.equal(fetched.draft.categories[0].products[0].name, "Hủ Tiếu Xào Bò");
});

test("17. a DRAFT import is invisible to Discovery until published", async () => {
  const platform = twoMerchants();
  platform.services.menuImport.importText("MERCHANT002", "Bánh Canh Cua 55k");
  const { organic } = await platform.agentSearch.searchMerchants("bánh canh cua");
  assert.equal(organic.length, 0); // not published yet — MERCHANT002's real fixture product doesn't match this query either
});

test("18. merchant review: getImport exposes uncertain fields for review", () => {
  const platform = twoMerchants();
  const record = platform.services.menuImport.importText("MERCHANT002", "Mì bò đặc biệt");
  assert.equal(record.draft.categories[0].products[0].needs_review, true);
});

test("19. merchant edits draft (fills in a missing price) and it's re-validated server-side", () => {
  const platform = twoMerchants();
  const record = platform.services.menuImport.importText("MERCHANT002", "Mì bò đặc biệt");
  const edited = structuredClone(record.draft);
  edited.categories[0].products[0].price = 70000;

  const updated = platform.services.menuImport.reviewImport("MERCHANT002", record.id, edited);
  assert.equal(updated.status, "DRAFT"); // clean now
  assert.equal(updated.draft.categories[0].products[0].needs_review, false);
});

test("reviewImport does not trust a client-supplied needs_review:false on an invalid price", () => {
  const platform = twoMerchants();
  const record = platform.services.menuImport.importText("MERCHANT002", "Mì bò đặc biệt");
  const edited = structuredClone(record.draft);
  edited.categories[0].products[0].price = -5; // invalid
  edited.categories[0].products[0].needs_review = false; // client lying

  const updated = platform.services.menuImport.reviewImport("MERCHANT002", record.id, edited);
  assert.equal(updated.draft.categories[0].products[0].needs_review, true); // server recomputed, ignored the lie
  assert.equal(updated.draft.categories[0].products[0].price, null);
});

// --- APPROVAL: 20-22 --------------------------------------------------------

test("20. a fully valid draft approves", () => {
  const platform = twoMerchants();
  const record = platform.services.menuImport.importText("MERCHANT002", "Hủ Tiếu Xào Bò 65k");
  const approved = platform.services.menuImport.approveImport("MERCHANT002", record.id);
  assert.equal(approved.status, "APPROVED");
});

test("21. a draft still needing review is rejected by approveImport with details", () => {
  const platform = twoMerchants();
  const record = platform.services.menuImport.importText("MERCHANT002", "Mì bò đặc biệt");
  assert.throws(() => platform.services.menuImport.approveImport("MERCHANT002", record.id), (err) => {
    assert.equal(err.code, "INVALID_DRAFT");
    assert.ok(Array.isArray(err.details) && err.details.length === 1);
    return true;
  });
});

test("22. MERCHANT003 cannot approve MERCHANT002's import", () => {
  const platform = twoMerchants();
  const record = platform.services.menuImport.importText("MERCHANT002", "Hủ Tiếu Xào Bò 65k");
  assert.throws(() => platform.services.menuImport.approveImport("MERCHANT003", record.id), (err) => {
    assert.equal(err.code, "UNAUTHORIZED_MERCHANT");
    return true;
  });
  // Untouched.
  assert.equal(platform.services.menuImport.getImport("MERCHANT002", record.id).status, "DRAFT");
});

// --- PUBLISH: 23-26 ----------------------------------------------------------

test("23. an approved draft publishes through MenuService and becomes real categories/products", () => {
  const platform = twoMerchants();
  const record = platform.services.menuImport.importText("MERCHANT002", "Hủ Tiếu Xào:\nHủ Tiếu Xào Đặc Biệt 90k");
  platform.services.menuImport.approveImport("MERCHANT002", record.id);
  const published = platform.services.menuImport.publishImport("MERCHANT002", record.id);
  assert.equal(published.status, "PUBLISHED");

  const menu = platform.services.menu.getMenu("MERCHANT002");
  const allProducts = menu.categories.flatMap((c) => c.products);
  assert.ok(allProducts.some((p) => p.name === "Hủ Tiếu Xào Đặc Biệt" && p.price === 90000));
});

test("24. an unapproved (DRAFT/REVIEW_REQUIRED) import cannot publish", () => {
  const platform = twoMerchants();
  const record = platform.services.menuImport.importText("MERCHANT002", "Hủ Tiếu Xào Bò 65k"); // DRAFT, not approved
  assert.throws(() => platform.services.menuImport.publishImport("MERCHANT002", record.id), (err) => {
    assert.equal(err.code, "IMPORT_NOT_APPROVED");
    return true;
  });
});

test("25. after publishing, the new product appears in Discovery/AgentSearchService", async () => {
  const platform = twoMerchants();
  const record = platform.services.menuImport.importText("MERCHANT002", "Hủ Tiếu Xào:\nBún Riêu Cua 45k");
  platform.services.menuImport.approveImport("MERCHANT002", record.id);
  platform.services.menuImport.publishImport("MERCHANT002", record.id);

  const { organic } = await platform.agentSearch.searchMerchants("bún riêu cua");
  assert.ok(organic.some((c) => c.merchant.merchant_id === "MERCHANT002"));
});

test("26. MERCHANT003 cannot publish MERCHANT002's approved import", () => {
  const platform = twoMerchants();
  const record = platform.services.menuImport.importText("MERCHANT002", "Hủ Tiếu Xào Bò 65k");
  platform.services.menuImport.approveImport("MERCHANT002", record.id);
  assert.throws(() => platform.services.menuImport.publishImport("MERCHANT003", record.id), (err) => {
    assert.equal(err.code, "UNAUTHORIZED_MERCHANT");
    return true;
  });
  assert.equal(platform.services.menuImport.getImport("MERCHANT002", record.id).status, "APPROVED"); // untouched
});

test("publishing twice fails with ALREADY_PUBLISHED, not a silent no-op or a crash", () => {
  const platform = twoMerchants();
  const record = platform.services.menuImport.importText("MERCHANT002", "Hủ Tiếu Xào Bò 65k");
  platform.services.menuImport.approveImport("MERCHANT002", record.id);
  platform.services.menuImport.publishImport("MERCHANT002", record.id);
  assert.throws(() => platform.services.menuImport.publishImport("MERCHANT002", record.id), (err) => {
    assert.equal(err.code, "ALREADY_PUBLISHED");
    return true;
  });
});

// --- TENANT ISOLATION: 27-30 -------------------------------------------------

test("27. MERCHANT002 cannot read MERCHANT003's import", () => {
  const platform = twoMerchants();
  const record = platform.services.menuImport.importText("MERCHANT003", "Hủ Tiếu Xào Bò 65k");
  assert.throws(() => platform.services.menuImport.getImport("MERCHANT002", record.id), (err) => {
    assert.equal(err.code, "UNAUTHORIZED_MERCHANT");
    return true;
  });
});

test("28. MERCHANT002 cannot modify (reviewImport) MERCHANT003's import", () => {
  const platform = twoMerchants();
  const record = platform.services.menuImport.importText("MERCHANT003", "Mì bò đặc biệt");
  const edited = structuredClone(record.draft);
  edited.categories[0].products[0].price = 70000;
  assert.throws(() => platform.services.menuImport.reviewImport("MERCHANT002", record.id, edited), (err) => {
    assert.equal(err.code, "UNAUTHORIZED_MERCHANT");
    return true;
  });
});

test("29. MERCHANT002 cannot approve MERCHANT003's import (duplicate of 22, explicit matrix item)", () => {
  const platform = twoMerchants();
  const record = platform.services.menuImport.importText("MERCHANT003", "Hủ Tiếu Xào Bò 65k");
  assert.throws(() => platform.services.menuImport.approveImport("MERCHANT002", record.id), (err) => {
    assert.equal(err.code, "UNAUTHORIZED_MERCHANT");
    return true;
  });
});

test("30. MERCHANT002 cannot publish MERCHANT003's import (duplicate of 26, explicit matrix item)", () => {
  const platform = twoMerchants();
  const record = platform.services.menuImport.importText("MERCHANT003", "Hủ Tiếu Xào Bò 65k");
  platform.services.menuImport.approveImport("MERCHANT003", record.id);
  assert.throws(() => platform.services.menuImport.publishImport("MERCHANT002", record.id), (err) => {
    assert.equal(err.code, "UNAUTHORIZED_MERCHANT");
    return true;
  });
});

// --- Misc: reject, invalid state transitions, IMPORT_NOT_FOUND ---------------

test("rejectImport keeps the record (audit trail), never deletes it", () => {
  const platform = twoMerchants();
  const record = platform.services.menuImport.importText("MERCHANT002", "Hủ Tiếu Xào Bò 65k");
  const rejected = platform.services.menuImport.rejectImport("MERCHANT002", record.id, "Giá sai");
  assert.equal(rejected.status, "REJECTED");
  assert.equal(rejected.reject_reason, "Giá sai");
  assert.deepEqual(platform.services.menuImport.getImport("MERCHANT002", record.id), rejected);
});

test("cannot approve an already-REJECTED import", () => {
  const platform = twoMerchants();
  const record = platform.services.menuImport.importText("MERCHANT002", "Hủ Tiếu Xào Bò 65k");
  platform.services.menuImport.rejectImport("MERCHANT002", record.id, "no");
  assert.throws(() => platform.services.menuImport.approveImport("MERCHANT002", record.id), (err) => {
    assert.equal(err.code, "INVALID_IMPORT_STATE");
    return true;
  });
});

test("getImport on a nonexistent id throws IMPORT_NOT_FOUND, not UNAUTHORIZED_MERCHANT", () => {
  const platform = twoMerchants();
  assert.throws(() => platform.services.menuImport.getImport("MERCHANT002", 999999), (err) => {
    assert.equal(err.code, "IMPORT_NOT_FOUND");
    return true;
  });
});

test("MENU_IMPORT_* audit events are recorded via the existing merchant_events sink", () => {
  const platform = twoMerchants();
  const record = platform.services.menuImport.importText("MERCHANT002", "Hủ Tiếu Xào Bò 65k");
  platform.services.menuImport.approveImport("MERCHANT002", record.id);
  platform.services.menuImport.publishImport("MERCHANT002", record.id);

  const events = platform.repos.analytics.listByMerchant("MERCHANT002", 20).map((e) => e.event_type);
  assert.ok(events.includes("MENU_IMPORT_STARTED"));
  assert.ok(events.includes("MENU_IMPORT_PARSED"));
  assert.ok(events.includes("MENU_IMPORT_APPROVED"));
  assert.ok(events.includes("MENU_IMPORT_PUBLISHED"));
});
