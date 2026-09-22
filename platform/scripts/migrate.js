import { platformConfig } from "../config.js";
import { createPlatformConnection, runPlatformMigrations } from "../db/connection.js";

const db = createPlatformConnection(platformConfig.dbPath);
runPlatformMigrations(db);
console.log(`Platform migrations applied on ${platformConfig.dbPath}`);
db.close();
