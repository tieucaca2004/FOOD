import express from "express";
import { platformConfig } from "../config.js";
import { requestId } from "../../src/api/middleware/requestId.js"; // generic, read-only reuse
import { rateLimit } from "../../src/api/middleware/rateLimit.js"; // generic, read-only reuse (params overridden below)
import { platformErrorHandler, platformNotFound } from "./middleware/errorHandler.js";
import { merchantRoutes } from "./routes/merchantRoutes.js";
import { merchantAuthRoutes } from "./routes/merchantAuthRoutes.js";
import { merchantOrderRoutes } from "./routes/merchantOrderRoutes.js";
import { searchRoutes } from "./routes/searchRoutes.js";
import { healthRoutes } from "./routes/healthRoutes.js";
import { createPlatformWebhookHandler } from "../channel/webhookController.js";
import { zaloWebhookSecurity } from "./middleware/zaloWebhookSecurity.js";
import { sanitizeWebhookErrors } from "./middleware/sanitizeWebhookErrors.js";
import { createTelegramWebhookHandler } from "../channel/telegramWebhookController.js";
import { telegramWebhookSecurity } from "./middleware/telegramWebhookSecurity.js";

export function createPlatformApp({ db, repos, services, discovery, merchantRouter, registry, router }) {
  const app = express();
  app.disable("x-powered-by");

  app.use(
    express.json({
      limit: "1mb",
      verify: (req, _res, buf) => {
        req.rawBody = buf.toString("utf8");
      },
    })
  );
  app.use(requestId);
  app.use(rateLimit({ windowMs: platformConfig.rateLimitWindowMs, max: platformConfig.rateLimitMax }));

  app.use("/api/platform", healthRoutes(db));
  app.use("/api/platform", merchantRoutes({ services, repos, registry }));
  app.use("/api/platform", merchantAuthRoutes({ merchantAuthService: services.merchantAuth }));
  app.use("/api/platform", merchantOrderRoutes({ merchantOrderService: services.merchantOrders, merchantAuthService: services.merchantAuth }));
  app.use("/api/platform", searchRoutes(discovery));

  app.post(platformConfig.webhookPath, zaloWebhookSecurity, sanitizeWebhookErrors, createPlatformWebhookHandler({ repos, services, router }));
  app.post(
    platformConfig.telegramWebhookPath,
    telegramWebhookSecurity,
    sanitizeWebhookErrors,
    createTelegramWebhookHandler({ repos, services, router })
  );

  app.use(platformNotFound);
  app.use(platformErrorHandler);

  return app;
}
