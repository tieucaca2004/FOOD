import { platformConfig } from "./config.js";
import { logger } from "../src/logger.js";
import { createPlatformConnection, runPlatformMigrations } from "./db/connection.js";
import { runPlatformSeed } from "./db/seed.js";
import { createPlatformRepositories } from "./repositories/index.js";
import { createPlatformServices } from "./services/index.js";
import { createConciergeAIProvider } from "./ai/index.js";
import { MerchantRegistry, buildAtieuAdapterFactory, buildGenericAdapterFactory } from "./merchant/MerchantRegistry.js";
import { MerchantRouter } from "./merchant/MerchantRouter.js";
import { DiscoveryEngine } from "./discovery/DiscoveryEngine.js";
import { AgentSearchService } from "./services/agentSearchService.js";
import { PlatformRouter } from "./router/PlatformRouter.js";
import { createPlatformApp } from "./api/app.js";

// A Tiểu's own engine, imported UNCHANGED — this is the "Merchant Matrix"
// running in-process, exactly as it does standalone via src/server.js. The
// platform never edits, forks, or re-implements any of this.
import { config as atieuConfig } from "../src/config.js";
import { createConnection as createAtieuConnection, runMigrations as runAtieuMigrations } from "../src/db/connection.js";
import { runSeed as runAtieuSeed } from "../src/db/seed.js";
import { createRepositories as createAtieuRepositories } from "../src/repositories/index.js";
import { createServices as createAtieuServices } from "../src/services/index.js";
import { createAIProvider as createAtieuAIProvider } from "../src/ai/index.js";
import { BusinessRouter as AtieuBusinessRouter } from "../src/router/businessRouter.js";

const platformDb = createPlatformConnection(platformConfig.dbPath);
runPlatformMigrations(platformDb);
runPlatformSeed(platformDb); // idempotent, registers only the real ATIEU001 merchant

const repos = createPlatformRepositories(platformDb);
const services = createPlatformServices(repos);
const ai = createConciergeAIProvider();

// Boot A Tiểu's engine against its own DB/config, completely as-is.
const atieuDb = createAtieuConnection(atieuConfig.dbPath);
runAtieuMigrations(atieuDb);
runAtieuSeed(atieuDb);
const atieuRepos = createAtieuRepositories(atieuDb);
const atieuServices = createAtieuServices(atieuRepos);
const atieuAI = createAtieuAIProvider();
const atieuRouter = new AtieuBusinessRouter(atieuServices, atieuAI);

const registry = new MerchantRegistry({
  repos,
  moduleFactories: {
    atieu: buildAtieuAdapterFactory({ services: atieuServices, router: atieuRouter }),
    generic: buildGenericAdapterFactory({ repos }),
  },
});

const merchantRouter = new MerchantRouter(registry);
const discovery = new DiscoveryEngine(services.merchantData, registry);
const agentSearch = new AgentSearchService({ discovery, registry });
const router = new PlatformRouter({ services, discovery, agentSearch, merchantRouter, ai });

const app = createPlatformApp({ db: platformDb, repos, services, discovery, merchantRouter, registry, router });

const server = app.listen(platformConfig.port, () => {
  logger.info("APP", `Tổng Đài platform listening on :${platformConfig.port}`, {
    webhookPath: platformConfig.webhookPath,
    aiProvider: platformConfig.aiProvider,
  });
});

function shutdown(signal) {
  logger.info("APP", `platform received ${signal}, shutting down`);
  server.close(() => {
    platformDb.close();
    atieuDb.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
