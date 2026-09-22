import { platformConfig } from "../config.js";
import { createPlatformConnection, runPlatformMigrations } from "../db/connection.js";
import { runPlatformSeed } from "../db/seed.js";

const db = createPlatformConnection(platformConfig.dbPath);
runPlatformMigrations(db);
runPlatformSeed(db);
console.log(`Platform seed applied on ${platformConfig.dbPath}`);
db.close();
