import { platformConfig } from "../config.js";
import { createPlatformConnection, runPlatformMigrations } from "../db/connection.js";
import { runPlatformSeed } from "../db/seed.js";
import { runNomNomDemoSeed } from "../db/demoSeed.js";

// Explicit, opt-in: seeds the [DEMO] Nôm Nôm Restaurant merchant. Never run
// automatically on server boot (see platform/db/demoSeed.js).
const db = createPlatformConnection(platformConfig.dbPath);
runPlatformMigrations(db);
runPlatformSeed(db);
const { merchantId, productCount } = runNomNomDemoSeed(db);
console.log(`Demo seed applied on ${platformConfig.dbPath}: ${merchantId} with ${productCount} products`);
db.close();
