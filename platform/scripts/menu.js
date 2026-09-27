import fs from "node:fs";
import path from "node:path";
import { platformConfig } from "../config.js";
import { createPlatformConnection, runPlatformMigrations } from "../db/connection.js";
import { createPlatformRepositories } from "../repositories/index.js";
import { createPlatformServices } from "../services/index.js";

// Operator tool for MERCHANT DATA UPDATES through the existing workflow (never a direct catalog write):
//   TEXT / IMAGE -> extraction -> DRAFT | REVIEW_REQUIRED -> APPROVED (a person) -> PUBLISHED (a person) -> search / AI
//   npm run platform:menu -- merchants
//   npm run platform:menu -- import-text <merchantId> --by <person> (--text "Bún Cá 45k" | --file menu.txt)
//   npm run platform:menu -- import-image <merchantId> <image.jpg|png|webp> --by <person>   (MENU_VISION_PROVIDER)
//   npm run platform:menu -- list <merchantId>
//   npm run platform:menu -- show <merchantId> <importId>        draft lines, flags, and "update of" current prices
//   npm run platform:menu -- approve <merchantId> <importId> --by <person>
//   npm run platform:menu -- reject <merchantId> <importId> --by <person> --reason "…"
//   npm run platform:menu -- publish <merchantId> <importId> --by <person>
//   npm run platform:menu -- set-address <merchantId> --by <person> --address "…"
// Every change is scoped to ONE merchant and recorded in merchant_events with who did it. An AI / system actor is
// refused: approving and publishing is a person's decision. DB: PLATFORM_SQLITE_PATH (or --db <file>).

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const positional = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--")));
const [command, merchantId, third] = positional;

const db = createPlatformConnection(flag("db") ?? platformConfig.dbPath);
runPlatformMigrations(db);
const repos = createPlatformRepositories(db);
const services = createPlatformServices(repos);

const NON_PERSON = /^(?:ai|gpt|llm|bot|system|auto|vision|ocr)(?:[:\s_-]|$)/i;
function person() {
  const by = flag("by");
  if (!by || NON_PERSON.test(by.trim())) throw new Error('--by <person> is required (a named person; not an AI / system actor)');
  return by.trim();
}
function merchant(id) {
  const m = id ? repos.merchants.getById(id) : null;
  if (!m) throw new Error(`Unknown merchant "${id ?? ""}"`);
  if (m.module !== "generic") console.warn(`note: ${m.merchant_id} is served by the "${m.module}" engine — catalog updates are used once it runs on the generic engine`);
  return m;
}
const vnd = (n) => (n == null ? "—" : `${Number(n).toLocaleString("vi-VN")}đ`);
function printImport(rec) {
  console.log(`#${rec.id} ${rec.merchant_id} ${rec.source_type} ${rec.status}${rec.error_message ? ` — ${rec.error_message}` : ""}${rec.reject_reason ? ` — rejected: ${rec.reject_reason}` : ""} (by ${rec.created_by ?? "?"}, ${rec.created_at})`);
  for (const c of rec.draft?.categories ?? []) {
    console.log(`  [${c.name ?? "—"}]`);
    for (const p of c.products ?? []) {
      const flags = [p.needs_review && "NEEDS REVIEW", p.possible_duplicate && "DUPLICATE?", p.existing_product_id != null && `UPDATE of #${p.existing_product_id} (now ${vnd(p.previous_price)})`].filter(Boolean).join(", ");
      console.log(`   - ${p.name}: ${vnd(p.price)}${flags ? `  <${flags}>` : ""}`);
    }
  }
}

try {
  switch (command) {
    case "merchants":
      for (const m of db.prepare(`SELECT merchant_id, name, module, status, address FROM merchants ORDER BY merchant_id`).all()) console.log(`${m.merchant_id}  ${m.name}  [${m.module}, ${m.status}]  📍 ${m.address ?? "(chưa có địa chỉ)"}`);
      break;
    case "import-text": {
      merchant(merchantId);
      const text = flag("text") ?? (flag("file") ? fs.readFileSync(flag("file"), "utf8") : null);
      if (!text?.trim()) throw new Error("--text or --file is required");
      printImport(services.menuImport.importText(merchantId, text, { createdBy: person() }));
      break;
    }
    case "import-image": {
      merchant(merchantId);
      if (!third) throw new Error("an image file is required");
      const ext = path.extname(third).toLowerCase();
      const mimeType = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" }[ext];
      if (!mimeType) throw new Error("image must be .jpg, .jpeg, .png or .webp");
      printImport(await services.menuImport.importImage(merchantId, { buffer: fs.readFileSync(third), mimeType }, { createdBy: person() }));
      break;
    }
    case "list":
      merchant(merchantId);
      for (const r of services.menuImport.listImports(merchantId)) console.log(`#${r.id} ${r.source_type} ${r.status} (by ${r.created_by ?? "?"}, ${r.updated_at})`);
      break;
    case "show":
      printImport(services.menuImport.getImport(merchant(merchantId).merchant_id, Number(third)));
      break;
    case "approve":
      merchant(merchantId);
      printImport(services.menuImport.approveImport(merchantId, Number(third), { by: person() }));
      break;
    case "reject": {
      merchant(merchantId);
      const reason = flag("reason");
      if (!reason?.trim()) throw new Error("--reason is required");
      printImport(services.menuImport.rejectImport(merchantId, Number(third), reason, { by: person() }));
      break;
    }
    case "publish":
      merchant(merchantId);
      printImport(services.menuImport.publishImport(merchantId, Number(third), { by: person() }));
      console.log(`published — ${services.menu.listProducts(merchantId).length} available products for ${merchantId}`);
      break;
    case "set-address": {
      merchant(merchantId);
      const m = services.merchants.updateAddress(merchantId, flag("address"), { by: person() });
      console.log(`${m.merchant_id}: 📍 ${m.address}`);
      break;
    }
    default:
      console.log("Usage: merchants | import-text <merchantId> --by <person> (--text … | --file …) | import-image <merchantId> <file> --by <person> | list <merchantId> | show <merchantId> <importId> | approve|publish <merchantId> <importId> --by <person> | reject <merchantId> <importId> --by <person> --reason … | set-address <merchantId> --by <person> --address …");
      process.exitCode = command ? 1 : 0;
  }
} catch (err) {
  console.error(`error: ${err.code ? `${err.code}: ` : ""}${err.message}`);
  process.exitCode = 1;
} finally {
  db.close();
}
