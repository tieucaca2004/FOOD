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

// Express 4 ignores a handler's returned promise; send a rejection to the
// error handler instead of letting it crash the process.
function asyncHandler(handler) {
  return (req, res, next) => handler(req, res, next).catch(next);
}

export function createPlatformApp({ db, repos, services, discovery, merchantRouter, registry, router }) {
  const app = express();
  app.disable("x-powered-by");
  // Which proxies may set the client IP the rate limiter keys on. Off unless
  // PLATFORM_TRUST_PROXY names them (see platform/config.js).
  app.set("trust proxy", platformConfig.trustProxy);

  // Before body parsing, so a request with a malformed body still gets a
  // request id and still counts against the rate limit.
  app.use(requestId);
  app.use(rateLimit({ windowMs: platformConfig.rateLimitWindowMs, max: platformConfig.rateLimitMax }));
  app.use(
    express.json({
      limit: "1mb",
      verify: (req, _res, buf) => {
        req.rawBody = buf.toString("utf8");
      },
    })
  );

  // Authorization zones:
  //   public   /api/platform/health, /readiness, /search
  //   admin    /api/platform/merchants*  (platform admin bearer token, fail closed;
  //            applied inside merchantRoutes and merchantAuthRoutes so the guard
  //            matches exactly the paths their routes match)
  //   merchant /api/platform/merchant/*  (per-merchant API key, see merchantOrderRoutes)
  //   webhooks Zalo and Telegram paths below (channel signature / secret token)
  app.use("/api/platform", healthRoutes(db));
  app.use("/api/platform", merchantRoutes({ services, repos, registry }));
  app.use("/api/platform", merchantAuthRoutes({ merchantAuthService: services.merchantAuth }));
  app.use("/api/platform", merchantOrderRoutes({ merchantOrderService: services.merchantOrders, merchantAuthService: services.merchantAuth }));
  app.use("/api/platform", searchRoutes(discovery));

  app.post(
    platformConfig.webhookPath,
    zaloWebhookSecurity,
    sanitizeWebhookErrors,
    asyncHandler(createPlatformWebhookHandler({ repos, services, router }))
  );
  app.post(
    platformConfig.telegramWebhookPath,
    telegramWebhookSecurity,
    sanitizeWebhookErrors,
    asyncHandler(createTelegramWebhookHandler({ repos, services, router }))
  );

  app.use(platformNotFound);
  app.use(platformErrorHandler);

  return app;
}
