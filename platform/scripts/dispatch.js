import { platformConfig } from "../config.js";
import { createPlatformConnection, runPlatformMigrations } from "../db/connection.js";
import { createPlatformRepositories } from "../repositories/index.js";
import { createPlatformServices } from "../services/index.js";
import { TelegramDispatchChannel, isValidTelegramDestination } from "../services/telegramDispatchChannel.js";

// Operator tool for generic merchant order dispatch (per-merchant config in
// merchant_dispatch_channels — never in code):
//   npm run platform:dispatch -- show [merchantId]
//   npm run platform:dispatch -- set <merchantId> telegram <chatId>
//   npm run platform:dispatch -- enable|disable <merchantId>
//   npm run platform:dispatch -- test <merchantId>     sends a test message to that merchant's destination
//   npm run platform:dispatch -- retry                 re-delivers failed orders (same as the server's retry job)
const [command, merchantId, channel, destination] = process.argv.slice(2);

const db = createPlatformConnection(platformConfig.dbPath);
runPlatformMigrations(db);
const repos = createPlatformRepositories(db);
const services = createPlatformServices(repos);

function requireMerchant(id) {
  const merchant = id ? repos.merchants.getById(id) : null;
  if (!merchant) {
    console.error(`Unknown merchant "${id ?? ""}"`);
    process.exit(1);
  }
  return merchant;
}

function show(row) {
  console.log(`${row.merchant_id}: ${row.channel} -> ${row.destination} (${row.enabled ? "enabled" : "disabled"}, updated ${row.updated_at})`);
}

try {
  switch (command) {
    case "show": {
      const rows = merchantId
        ? [repos.merchantDispatch.getChannel(merchantId)].filter(Boolean)
        : db.prepare(`SELECT * FROM merchant_dispatch_channels ORDER BY merchant_id`).all();
      if (rows.length === 0) console.log("No dispatch channel configured.");
      rows.forEach(show);
      break;
    }
    case "set": {
      requireMerchant(merchantId);
      if (channel !== "telegram") throw new Error(`Unsupported channel "${channel}" (supported: telegram)`);
      if (!isValidTelegramDestination(destination)) throw new Error(`"${destination}" is not a Telegram chat id`);
      show(repos.merchantDispatch.setChannel(merchantId, { channel, destination: destination.trim(), enabled: true }));
      break;
    }
    case "enable":
    case "disable": {
      requireMerchant(merchantId);
      const row = repos.merchantDispatch.setChannelEnabled(merchantId, command === "enable");
      if (!row) throw new Error(`${merchantId} has no dispatch channel — use "set" first`);
      show(row);
      break;
    }
    case "test": {
      const merchant = requireMerchant(merchantId);
      const config = repos.merchantDispatch.getChannel(merchantId);
      if (!config) throw new Error(`${merchantId} has no dispatch channel — use "set" first`);
      const result = await new TelegramDispatchChannel().deliver({
        destination: config.destination,
        text: `🔔 Tin thử từ Tổng Đài: đơn hàng của ${merchant.name} sẽ được gửi tới đây.`,
      });
      console.log(result.ok ? "Test message delivered." : `Test message NOT delivered: ${result.error}`);
      process.exitCode = result.ok ? 0 : 1;
      break;
    }
    case "retry": {
      const results = await services.orders.retryFailedDispatches();
      if (results.length === 0) console.log("Nothing to retry.");
      for (const r of results) console.log(`${r.orderCode} (${r.merchantId}): ${r.delivered ? "delivered" : `not delivered — ${r.reason}`}`);
      break;
    }
    default:
      console.log("Usage: show [merchantId] | set <merchantId> telegram <chatId> | enable|disable <merchantId> | test <merchantId> | retry");
      process.exitCode = command ? 1 : 0;
  }
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  db.close();
}
