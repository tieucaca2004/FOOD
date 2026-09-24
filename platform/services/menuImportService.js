import { parseMenuText, flagDuplicates } from "./menuParserService.js";
import { validateMenuImage } from "./imageValidation.js";

function importError(code, message, status = 400) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  return err;
}

const PRE_APPROVAL_STATUSES = new Set(["DRAFT", "REVIEW_REQUIRED"]);

function isValidProduct(product) {
  return (
    typeof product.name === "string" &&
    product.name.trim().length > 0 &&
    Number.isInteger(product.price) &&
    product.price >= 0 &&
    product.needs_review !== true
  );
}

function recomputeReviewFlags(draft) {
  for (const category of draft.categories || []) {
    for (const product of category.products || []) {
      const priceOk = Number.isInteger(product.price) && product.price >= 0;
      if (!priceOk) {
        product.price = null;
        product.needs_review = true;
      } else {
        product.needs_review = false;
      }
    }
  }
  return flagDuplicates(draft);
}

function draftHasReviewItems(draft) {
  return (draft.categories || []).some((c) => (c.products || []).some((p) => p.needs_review));
}

function collectInvalidItems(draft) {
  const invalid = [];
  for (const category of draft.categories || []) {
    for (const product of category.products || []) {
      if (!isValidProduct(product)) {
        invalid.push({ category: category.name, name: product.name, price: product.price, needs_review: product.needs_review });
      }
    }
  }
  return invalid;
}

/**
 * Orchestrates the Menu Import pipeline (spec §5): TEXT or IMAGE ->
 * (parser | vision provider + parser normalization) -> MenuDraft -> review
 * -> approve -> publish (through MenuService only). Every method takes the
 * caller's own merchantId and verifies the import record actually belongs
 * to it before doing anything — an import can never be read, edited,
 * approved, rejected, or published by a merchant that doesn't own it.
 */
export class MenuImportService {
  constructor({ repos, menuService, visionProvider, imageStorage }) {
    this.repos = repos;
    this.menuService = menuService;
    this.visionProvider = visionProvider;
    this.imageStorage = imageStorage;
  }

  _audit(merchantId, importId, eventType, extra) {
    this.repos.analytics.logMerchantEvent({
      merchantId,
      eventType,
      externalRef: String(importId),
      payload: { sourceType: extra?.sourceType, ...extra },
    });
  }

  _ownedImport(merchantId, importId) {
    const record = this.repos.menuImports.getById(importId);
    if (!record) throw importError("IMPORT_NOT_FOUND", `Import ${importId} not found`, 404);
    if (record.merchant_id !== merchantId) {
      throw importError("UNAUTHORIZED_MERCHANT", `Import ${importId} does not belong to merchant ${merchantId}`, 403);
    }
    return record;
  }

  getImport(merchantId, importId) {
    return this._ownedImport(merchantId, importId);
  }

  listImports(merchantId) {
    return this.repos.menuImports.listByMerchant(merchantId);
  }

  importText(merchantId, rawText, { createdBy } = {}) {
    const record = this.repos.menuImports.create({ merchantId, sourceType: "TEXT", sourceReference: rawText, createdBy });
    this._audit(merchantId, record.id, "MENU_IMPORT_STARTED", { sourceType: "TEXT" });

    let draft;
    try {
      draft = flagDuplicates(parseMenuText(rawText));
    } catch (err) {
      const failed = this.repos.menuImports.setFailed(record.id, `PARSE_FAILED: ${err.message}`);
      this._audit(merchantId, record.id, "MENU_IMPORT_FAILED", { sourceType: "TEXT", error: err.message });
      return failed;
    }

    return this._finishDraft(merchantId, record.id, draft, "TEXT");
  }

  async importImage(merchantId, { buffer, mimeType }, { createdBy } = {}) {
    // Validated BEFORE any import record exists — an invalid upload isn't
    // a real import attempt, so it leaves no partial record/audit trail.
    const realMimeType = validateMenuImage(buffer, mimeType);
    const sourceReference = this.imageStorage.save(buffer, realMimeType);

    const record = this.repos.menuImports.create({ merchantId, sourceType: "IMAGE", sourceReference, createdBy });
    this._audit(merchantId, record.id, "MENU_IMPORT_STARTED", { sourceType: "IMAGE" });

    let ocrResult;
    try {
      ocrResult = await this.visionProvider.parseImage(buffer, realMimeType);
    } catch (err) {
      const code = err.code || "VISION_PROVIDER_ERROR";
      const failed = this.repos.menuImports.setFailed(record.id, `${code}: ${err.message}`);
      this._audit(merchantId, record.id, "MENU_IMPORT_FAILED", { sourceType: "IMAGE", error: err.message, code });
      return failed;
    }

    let draft;
    try {
      draft = flagDuplicates(this._normalizeOcrResult(ocrResult));
    } catch (err) {
      const failed = this.repos.menuImports.setFailed(record.id, `PARSE_FAILED: ${err.message}`);
      this._audit(merchantId, record.id, "MENU_IMPORT_FAILED", { sourceType: "IMAGE", error: err.message });
      return failed;
    }

    return this._finishDraft(merchantId, record.id, draft, "IMAGE");
  }

  // Normalizes a vision provider's raw output into the same MenuDraft
  // shape parseMenuText() produces — this is the point where TEXT and
  // IMAGE pipelines converge (spec §26). Never invents a price: a product
  // with no price field, or a non-integer one, becomes price: null,
  // needs_review: true, exactly like the text parser.
  _normalizeOcrResult(raw) {
    if (!raw || !Array.isArray(raw.categories)) {
      throw new Error("Vision provider output missing categories[]");
    }
    return {
      categories: raw.categories.map((c) => ({
        name: c.name ?? null,
        products: (c.products || []).map((p) => {
          const priceOk = Number.isInteger(p.price) && p.price >= 0;
          return {
            name: p.name ?? "",
            price: priceOk ? p.price : null,
            description: p.description ?? null,
            available: true,
            keywords: [],
            confidence: typeof p.confidence === "number" ? p.confidence : null,
            needs_review: !priceOk || !p.name || (typeof p.confidence === "number" && p.confidence < 0.6),
            possible_duplicate: false,
          };
        }),
      })),
    };
  }

  _finishDraft(merchantId, importId, draft, sourceType) {
    this._audit(merchantId, importId, "MENU_IMPORT_PARSED", { sourceType });
    const status = draftHasReviewItems(draft) ? "REVIEW_REQUIRED" : "DRAFT";
    const saved = this.repos.menuImports.setDraft(importId, status, draft);
    if (status === "REVIEW_REQUIRED") {
      this._audit(merchantId, importId, "MENU_IMPORT_REVIEW_REQUIRED", { sourceType });
    }
    return saved;
  }

  // Merchant edits the draft (fix a missing price, rename a product,
  // resolve a flagged duplicate, etc). Every edited field is re-validated
  // server-side — the client's own needs_review claim is never trusted,
  // it's always recomputed from the actual price/name (spec §18).
  reviewImport(merchantId, importId, editedDraft) {
    const record = this._ownedImport(merchantId, importId);
    if (!PRE_APPROVAL_STATUSES.has(record.status)) {
      throw importError("INVALID_IMPORT_STATE", `Cannot edit import ${importId} in status ${record.status}`, 409);
    }
    if (!editedDraft || !Array.isArray(editedDraft.categories)) {
      throw importError("INVALID_DRAFT", "Edited draft must have a categories[] array");
    }

    const normalized = recomputeReviewFlags(editedDraft);
    const status = draftHasReviewItems(normalized) ? "REVIEW_REQUIRED" : "DRAFT";
    return this.repos.menuImports.setDraft(importId, status, normalized);
  }

  approveImport(merchantId, importId) {
    const record = this._ownedImport(merchantId, importId);
    if (!PRE_APPROVAL_STATUSES.has(record.status)) {
      throw importError("INVALID_IMPORT_STATE", `Cannot approve import ${importId} in status ${record.status}`, 409);
    }

    const invalidItems = collectInvalidItems(record.draft || { categories: [] });
    if (invalidItems.length > 0) {
      const err = importError("INVALID_DRAFT", `${invalidItems.length} item(s) still need review before approval`);
      err.details = invalidItems;
      throw err;
    }

    const approved = this.repos.menuImports.setStatus(importId, "APPROVED");
    this._audit(merchantId, importId, "MENU_IMPORT_APPROVED", { sourceType: record.source_type });
    return approved;
  }

  rejectImport(merchantId, importId, reason) {
    const record = this._ownedImport(merchantId, importId);
    if (!PRE_APPROVAL_STATUSES.has(record.status)) {
      throw importError("INVALID_IMPORT_STATE", `Cannot reject import ${importId} in status ${record.status}`, 409);
    }
    const rejected = this.repos.menuImports.setRejected(importId, reason);
    this._audit(merchantId, importId, "MENU_IMPORT_REJECTED", { sourceType: record.source_type, reason });
    return rejected;
  }

  publishImport(merchantId, importId) {
    const record = this._ownedImport(merchantId, importId);
    if (record.status === "PUBLISHED") {
      throw importError("ALREADY_PUBLISHED", `Import ${importId} was already published`, 409);
    }
    if (record.status !== "APPROVED") {
      throw importError("IMPORT_NOT_APPROVED", `Import ${importId} is not approved (status: ${record.status})`, 409);
    }

    // The only write path into published menu tables — MenuService owns
    // the publish itself (spec §20, never bypassed). Applying the draft and
    // marking the import PUBLISHED commit together: if either fails, neither
    // happens, so a retry can never add the draft's products a second time.
    const publish = this.repos.menuImports.db.transaction(() => {
      if (this.repos.menuImports.getById(importId).status === "PUBLISHED") {
        throw importError("ALREADY_PUBLISHED", `Import ${importId} was already published`, 409);
      }
      this.menuService.applyPublishedDraft(merchantId, record.draft);
      return this.repos.menuImports.setStatus(importId, "PUBLISHED");
    });
    const published = publish();
    this._audit(merchantId, importId, "MENU_IMPORT_PUBLISHED", { sourceType: record.source_type });
    return published;
  }
}
