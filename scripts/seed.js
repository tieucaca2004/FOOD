import { config } from "../src/config.js";
import { createConnection, runMigrations } from "../src/db/connection.js";
import { runSeed } from "../src/db/seed.js";

const db = createConnection(config.dbPath);
runMigrations(db);
runSeed(db);
console.log(`Seed applied on ${config.dbPath}`);
db.close();
