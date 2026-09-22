import { config } from "../src/config.js";
import { createConnection, runMigrations } from "../src/db/connection.js";

const db = createConnection(config.dbPath);
runMigrations(db);
console.log(`Migrations applied on ${config.dbPath}`);
db.close();
