import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "../logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SEED_DIR = path.join(__dirname, "..", "..", "data", "seed");

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.join(SEED_DIR, file), "utf8"));
}

// Idempotent: safe to run repeatedly. Upserts by natural key (category name,
// product sku, settings key) — never deletes existing carts/orders/customers.
export function runSeed(db) {
  const categories = readJson("categories.json");
  const products = readJson("products.json");
  const settings = readJson("business_settings.json");

  // categories.name has no UNIQUE constraint in the base schema; add one
  // defensively so the upsert's ON CONFLICT(name) has something to target.
  // Must run before preparing the statement below — better-sqlite3 compiles
  // prepared statements immediately, so the index has to exist first.
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_categories_name ON categories(name)`);

  const upsertCategory = db.prepare(`
    INSERT INTO categories (name, sort_order) VALUES (@name, @sort_order)
    ON CONFLICT(name) DO UPDATE SET sort_order = excluded.sort_order
  `);
  const getCategoryByName = db.prepare(`SELECT id FROM categories WHERE name = ?`);

  const seedTx = db.transaction(() => {
    for (const c of categories) {
      upsertCategory.run(c);
    }

    const upsertProduct = db.prepare(`
      INSERT INTO products (sku, name, category_id, description, price, image_url, available, sort_order, keywords_json, updated_at)
      VALUES (@sku, @name, @category_id, @description, @price, @image_url, @available, @sort_order, @keywords_json, datetime('now'))
      ON CONFLICT(sku) DO UPDATE SET
        name = excluded.name,
        category_id = excluded.category_id,
        description = excluded.description,
        price = excluded.price,
        image_url = excluded.image_url,
        available = excluded.available,
        sort_order = excluded.sort_order,
        keywords_json = excluded.keywords_json,
        updated_at = datetime('now')
    `);

    for (const p of products) {
      const category = getCategoryByName.get(p.category);
      if (!category) {
        throw new Error(`Seed error: category "${p.category}" not found for product ${p.sku}`);
      }
      upsertProduct.run({
        sku: p.sku,
        name: p.name,
        category_id: category.id,
        description: p.description || null,
        price: p.price,
        image_url: p.image_url || null,
        available: p.available ? 1 : 0,
        sort_order: p.sort_order || 0,
        keywords_json: JSON.stringify(p.keywords || []),
      });
    }

    const upsertSetting = db.prepare(`
      INSERT INTO business_settings (key, value, updated_at) VALUES (@key, @value, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
    `);
    for (const [key, value] of Object.entries(settings)) {
      upsertSetting.run({ key, value: String(value) });
    }
  });

  seedTx();
  logger.info("DB", "seed applied", {
    categories: categories.length,
    products: products.length,
    settings: Object.keys(settings).length,
  });
}
