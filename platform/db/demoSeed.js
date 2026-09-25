import fs from "node:fs";
import { logger } from "../../src/logger.js";
import { deriveAccountFieldsFromLegacyStatus } from "../domain/merchantStatus.js";

// DEMO / NON-PRODUCTION merchant seed. Deliberately NOT part of
// runPlatformSeed() (which runs on every server boot and must only ever
// register the real ATIEU001) — this runs only when invoked explicitly via
// `npm run platform:seed:demo`.
//
// Source of truth: platform/db/demo/nomnom_demo_source_snapshot.json, kept
// byte-for-byte as supplied. Only name + price_vnd (+ address/lat/lng) are
// used; the source has no description/category/unit/price_off, so products
// get none. The shop's marketplace blurb (desc_verbatim) is not a
// restaurant description and is not copied; the free-text opening hours
// are stored verbatim as a setting, never parsed into opening_hours_json.
//
// Uses the generic merchant engine only (module 'generic') — no
// merchant-specific code. No phone is stored and orders for generic
// merchants go through NullMerchantDispatchPort, so nothing ever reaches
// the real restaurant. No `is_demo` column exists; the demo marker lives in
// the existing merchant_settings table plus the "[DEMO]" name prefix.

const SNAPSHOT_URL = new URL("./demo/nomnom_demo_source_snapshot.json", import.meta.url);

export const NOMNOM_DEMO_MERCHANT_ID = "DEMO_NOMNOM001";

export function loadNomNomSnapshot() {
  const snapshot = JSON.parse(fs.readFileSync(SNAPSHOT_URL, "utf8"));
  const names = new Set();
  for (const p of snapshot.products) {
    if (typeof p.name !== "string" || !p.name) throw new Error(`demo snapshot: product ${p.position} has no name`);
    if (!Number.isInteger(p.price_vnd) || p.price_vnd < 0) throw new Error(`demo snapshot: bad price_vnd for "${p.name}"`);
    if (names.has(p.name)) throw new Error(`demo snapshot: duplicate product name "${p.name}"`);
    names.add(p.name);
  }
  return snapshot;
}

export function demoSku(product) {
  return `NN-${String(product.position).padStart(3, "0")}`;
}

export function runNomNomDemoSeed(db, snapshot = loadNomNomSnapshot()) {
  const source = snapshot.merchant_source;
  const merchantId = NOMNOM_DEMO_MERCHANT_ID;
  const { accountStatus, active } = deriveAccountFieldsFromLegacyStatus("ACTIVE");

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO merchants (merchant_id, name, slug, module, status, account_status, active, description, address, phone, latitude, longitude, opening_hours_json)
       VALUES (@merchant_id, @name, @slug, 'generic', 'ACTIVE', @account_status, @active, NULL, @address, NULL, @latitude, @longitude, NULL)
       ON CONFLICT(merchant_id) DO UPDATE SET
         name = excluded.name,
         slug = excluded.slug,
         module = excluded.module,
         status = excluded.status,
         account_status = excluded.account_status,
         active = excluded.active,
         description = NULL,
         address = excluded.address,
         phone = NULL,
         latitude = excluded.latitude,
         longitude = excluded.longitude,
         opening_hours_json = NULL,
         updated_at = datetime('now')`
    ).run({
      merchant_id: merchantId,
      name: `[DEMO] ${source.name}`,
      slug: `demo-${source.slug}`,
      account_status: accountStatus,
      active: active ? 1 : 0,
      address: source.address,
      latitude: source.lat,
      longitude: source.lng,
    });

    const hasSub = db.prepare(`SELECT id FROM merchant_subscriptions WHERE merchant_id = ?`).get(merchantId);
    if (!hasSub) {
      db.prepare(
        `INSERT INTO merchant_subscriptions (merchant_id, plan_id, status, started_at) VALUES (?, 'free', 'ACTIVE', datetime('now'))`
      ).run(merchantId);
    }

    const setSetting = db.prepare(
      `INSERT INTO merchant_settings (merchant_id, key, value) VALUES (?, ?, ?)
       ON CONFLICT(merchant_id, key) DO UPDATE SET value = excluded.value`
    );
    setSetting.run(merchantId, "is_demo", "true");
    setSetting.run(merchantId, "environment", "non-production");
    setSetting.run(merchantId, "source_url", snapshot._meta.source_url);
    setSetting.run(merchantId, "source_shop_id", source.source_shop_id);
    setSetting.run(merchantId, "open_hours_text", source.open_hours_text_in_desc ?? null);

    const findBySku = db.prepare(`SELECT id FROM merchant_products WHERE merchant_id = ? AND sku = ?`);
    const findByName = db.prepare(`SELECT id FROM merchant_products WHERE merchant_id = ? AND name = ?`);
    const adoptSku = db.prepare(`UPDATE merchant_products SET sku = ? WHERE id = ?`);
    const upsertProduct = db.prepare(
      `INSERT INTO merchant_products (merchant_id, sku, name, category_id, description, price, available, sort_order, keywords_json)
       VALUES (@merchant_id, @sku, @name, NULL, NULL, @price, 1, @sort_order, '[]')
       ON CONFLICT(merchant_id, sku) DO UPDATE SET
         name = excluded.name,
         category_id = NULL,
         description = NULL,
         price = excluded.price,
         available = 1,
         sort_order = excluded.sort_order,
         updated_at = datetime('now')`
    );

    const skus = [];
    for (const product of snapshot.products) {
      const sku = demoSku(product);
      skus.push(sku);
      // A row seeded under an older SKU scheme is re-keyed by its (unique)
      // name instead of being duplicated — keeps product ids stable for any
      // existing cart/order rows.
      if (!findBySku.get(merchantId, sku)) {
        const existing = findByName.get(merchantId, product.name);
        if (existing) adoptSku.run(sku, existing.id);
      }
      upsertProduct.run({ merchant_id: merchantId, sku, name: product.name, price: product.price_vnd, sort_order: product.position });
    }
    // A product no longer in the snapshot is hidden, not deleted — it may
    // already be referenced by demo cart/order rows.
    const placeholders = skus.map(() => "?").join(",");
    db.prepare(
      `UPDATE merchant_products SET available = 0, updated_at = datetime('now') WHERE merchant_id = ? AND sku NOT IN (${placeholders})`
    ).run(merchantId, ...skus);

    const menu = db.prepare(`SELECT id FROM merchant_menus WHERE merchant_id = ?`).get(merchantId);
    if (menu) {
      db.prepare(`UPDATE merchant_menus SET status = 'PUBLISHED', updated_at = datetime('now') WHERE merchant_id = ?`).run(merchantId);
    } else {
      db.prepare(`INSERT INTO merchant_menus (merchant_id, name, status) VALUES (?, ?, 'PUBLISHED')`).run(merchantId, `[DEMO] ${source.name}`);
    }
  });
  tx();

  logger.info("DB", "demo merchant seed applied", { merchantId, products: snapshot.products.length });
  return { merchantId, productCount: snapshot.products.length };
}
