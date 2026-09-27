import fs from "node:fs";
import { logger } from "../../src/logger.js";

// A Tiểu (ATIEU001) catalog for the GENERIC merchant engine — the same
// merchant_categories/merchant_products/merchant_menus tables every generic
// merchant uses (see demoSeed.js for Nôm Nôm). No A Tiểu-specific code path:
// once ATIEU001's module is 'generic', GenericMerchantAdapter +
// ConversationalOrderingEngine serve it like any other merchant.
//
// Source of truth: platform/db/catalog/atieu_menu.json, kept byte-for-byte
// as supplied (76 products, 13 categories). Only the fields the current
// schema has a column for are stored: category, name, description,
// price_vnd, image_file (as image_url, verbatim). name_en, icon,
// category_icon, star_badge and image_size_px have no column and stay in
// the snapshot only. An empty string in the source means "none" -> NULL.
// Nothing is invented: no keywords, no descriptions, no prices.
//
// Idempotent: products are keyed by a stable SKU derived from their position
// in the source (AT-001…AT-076), categories by name. Re-running never
// duplicates; a product dropped from the source is hidden, never deleted
// (cart/order rows may reference it).
//
// The legacy A Tiểu module (src/) and its own DB are never touched.

const SNAPSHOT_URL = new URL("./catalog/atieu_menu.json", import.meta.url);

export const ATIEU_MERCHANT_ID = "ATIEU001";

export function loadAtieuCatalog() {
  const snapshot = JSON.parse(fs.readFileSync(SNAPSHOT_URL, "utf8"));
  const items = snapshot.items;
  if (!Array.isArray(items) || items.length !== snapshot.item_count) {
    throw new Error(`atieu catalog: item_count ${snapshot.item_count} does not match ${items?.length} items`);
  }
  const names = new Set();
  for (const [i, p] of items.entries()) {
    if (typeof p.name !== "string" || !p.name.trim()) throw new Error(`atieu catalog: item ${i + 1} has no name`);
    if (typeof p.category !== "string" || !p.category.trim()) throw new Error(`atieu catalog: "${p.name}" has no category`);
    if (!Number.isInteger(p.price_vnd) || p.price_vnd < 0) throw new Error(`atieu catalog: bad price_vnd for "${p.name}"`);
    if (names.has(p.name)) throw new Error(`atieu catalog: duplicate product name "${p.name}"`);
    names.add(p.name);
  }
  return snapshot;
}

export function atieuSku(position) {
  return `AT-${String(position).padStart(3, "0")}`;
}

const orNull = (value) => (typeof value === "string" && value.trim() ? value : null);

export function runAtieuCatalogSeed(db, snapshot = loadAtieuCatalog()) {
  const merchantId = ATIEU_MERCHANT_ID;
  if (!db.prepare(`SELECT 1 FROM merchants WHERE merchant_id = ?`).get(merchantId)) {
    throw new Error(`atieu catalog: merchant ${merchantId} is not registered (run the platform seed first)`);
  }

  const tx = db.transaction(() => {
    // Categories in source order (first appearance), matched by exact name.
    const categoryIds = new Map();
    const findCategory = db.prepare(`SELECT id FROM merchant_categories WHERE merchant_id = ? AND name = ? ORDER BY id LIMIT 1`);
    const insertCategory = db.prepare(`INSERT INTO merchant_categories (merchant_id, name, sort_order) VALUES (?, ?, ?)`);
    const sortCategory = db.prepare(`UPDATE merchant_categories SET sort_order = ? WHERE id = ?`);
    for (const p of snapshot.items) {
      if (categoryIds.has(p.category)) continue;
      const sortOrder = categoryIds.size + 1;
      const existing = findCategory.get(merchantId, p.category);
      if (existing) {
        sortCategory.run(sortOrder, existing.id);
        categoryIds.set(p.category, existing.id);
      } else {
        categoryIds.set(p.category, insertCategory.run(merchantId, p.category, sortOrder).lastInsertRowid);
      }
    }

    const findBySku = db.prepare(`SELECT id FROM merchant_products WHERE merchant_id = ? AND sku = ?`);
    const findByName = db.prepare(`SELECT id FROM merchant_products WHERE merchant_id = ? AND name = ?`);
    const adoptSku = db.prepare(`UPDATE merchant_products SET sku = ? WHERE id = ?`);
    const upsertProduct = db.prepare(
      `INSERT INTO merchant_products (merchant_id, sku, name, category_id, description, price, image_url, available, sort_order, keywords_json)
       VALUES (@merchant_id, @sku, @name, @category_id, @description, @price, @image_url, 1, @sort_order, '[]')
       ON CONFLICT(merchant_id, sku) DO UPDATE SET
         name = excluded.name,
         category_id = excluded.category_id,
         description = excluded.description,
         price = excluded.price,
         image_url = excluded.image_url,
         available = 1,
         sort_order = excluded.sort_order,
         updated_at = datetime('now')`
    );

    const skus = [];
    for (const [i, p] of snapshot.items.entries()) {
      const position = i + 1;
      const sku = atieuSku(position);
      skus.push(sku);
      // A row with the same name under another SKU is re-keyed, not duplicated.
      if (!findBySku.get(merchantId, sku)) {
        const existing = findByName.get(merchantId, p.name);
        if (existing) adoptSku.run(sku, existing.id);
      }
      upsertProduct.run({
        merchant_id: merchantId,
        sku,
        name: p.name,
        category_id: categoryIds.get(p.category),
        description: orNull(p.description),
        price: p.price_vnd,
        image_url: orNull(p.image_file),
        sort_order: position,
      });
    }
    const placeholders = skus.map(() => "?").join(",");
    db.prepare(
      `UPDATE merchant_products SET available = 0, updated_at = datetime('now') WHERE merchant_id = ? AND sku NOT IN (${placeholders})`
    ).run(merchantId, ...skus);

    const setSetting = db.prepare(
      `INSERT INTO merchant_settings (merchant_id, key, value) VALUES (?, ?, ?)
       ON CONFLICT(merchant_id, key) DO UPDATE SET value = excluded.value`
    );
    setSetting.run(merchantId, "catalog_source_url", snapshot.source ?? null);
    setSetting.run(merchantId, "catalog_extracted_on", snapshot.extracted ?? null);

    if (db.prepare(`SELECT id FROM merchant_menus WHERE merchant_id = ?`).get(merchantId)) {
      db.prepare(`UPDATE merchant_menus SET status = 'PUBLISHED', updated_at = datetime('now') WHERE merchant_id = ?`).run(merchantId);
    } else {
      db.prepare(`INSERT INTO merchant_menus (merchant_id, name, status) VALUES (?, ?, 'PUBLISHED')`).run(merchantId, "Hủ Tiếu Xào A Tiểu");
    }
  });
  tx();

  logger.info("DB", "atieu generic catalog seed applied", { merchantId, products: snapshot.items.length });
  return { merchantId, productCount: snapshot.items.length };
}
