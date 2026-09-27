import { platformConfig } from "../config.js";
import { createPlatformConnection } from "../db/connection.js";
import { createPlatformRepositories } from "../repositories/index.js";
import { ProductLanguageService } from "../services/productLanguageService.js";

// Read-only audit of what the agent has learned for one merchant:
//   npm run platform:aliases -- <merchant_id>
// (A CLI rather than an HTTP route: the platform's admin routes have no
// authentication yet, and this data should not be publicly reachable.)
const merchantId = process.argv[2];
if (!merchantId) {
  console.error("usage: npm run platform:aliases -- <merchant_id>");
  process.exit(1);
}

// Read-only: never migrates. Before migration 010 has been applied (by the
// server on start), there is simply nothing learned to show.
const db = createPlatformConnection(platformConfig.dbPath);
if (!db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'merchant_product_aliases'`).get()) {
  console.log("Nothing learned yet (migration 010 not applied — the platform applies it on start).");
  db.close();
  process.exit(0);
}
const repos = createPlatformRepositories(db);
const merchant = repos.merchants.getById(merchantId);
if (!merchant) {
  console.error(`merchant ${merchantId} not found`);
  process.exit(1);
}

const products = new ProductLanguageService(repos).listForMerchant(merchantId);
console.log(merchant.name);
if (products.length === 0) console.log("  (nothing learned yet)");
for (const p of products) {
  console.log(`\n${p.productName}${p.available ? "" : "  [unavailable — aliases ignored]"}`);
  p.aliases.forEach((a, i) => {
    const branch = i === p.aliases.length - 1 ? "└──" : "├──";
    console.log(`${branch} ${a.alias.padEnd(26)} ${a.confidence.toFixed(2)}  ${a.status.padEnd(10)} obs ${a.observed} / ok ${a.confirmed} / no ${a.rejected}`);
  });
}
db.close();
