import { platformConfig } from "../config.js";
import { createPlatformConnection, runPlatformMigrations } from "../db/connection.js";
import { runPlatformSeed } from "../db/seed.js";
import { runAtieuCatalogSeed, ATIEU_MERCHANT_ID } from "../db/atieuCatalogSeed.js";

// Explicit, idempotent: imports A Tiểu's catalog (platform/db/catalog/
// atieu_menu.json) into the generic merchant tables for ATIEU001. Which
// engine serves ATIEU001 is still decided by PLATFORM_ATIEU_ENGINE only
// (see platform/db/seed.js) — this script never switches it by itself.
const db = createPlatformConnection(platformConfig.dbPath);
runPlatformMigrations(db);
runPlatformSeed(db);
const { productCount } = runAtieuCatalogSeed(db);
const { module } = db.prepare(`SELECT module FROM merchants WHERE merchant_id = ?`).get(ATIEU_MERCHANT_ID);
const stored = db.prepare(`SELECT COUNT(*) AS n FROM merchant_products WHERE merchant_id = ? AND available = 1`).get(ATIEU_MERCHANT_ID).n;
console.log(`A Tiểu catalog applied on ${platformConfig.dbPath}: ${productCount} source products, ${stored} available in DB; ATIEU001 module = ${module}`);
db.close();
