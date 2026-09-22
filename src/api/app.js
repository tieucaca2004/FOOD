import express from "express";
import { config } from "../config.js";
import { requestId } from "./middleware/requestId.js";
import { rateLimit } from "./middleware/rateLimit.js";
import { errorHandler, notFound } from "./middleware/errorHandler.js";
import { menuRoutes } from "./routes/menuRoutes.js";
import { cartRoutes } from "./routes/cartRoutes.js";
import { orderRoutes } from "./routes/orderRoutes.js";
import { customerRoutes } from "./routes/customerRoutes.js";
import { healthRoutes } from "./routes/healthRoutes.js";
import { createZaloWebhookHandler } from "../channel/zalo/webhookController.js";
import { BusinessRouter } from "../router/businessRouter.js";

export function createApp({ db, repos, services, ai }) {
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
  app.use(rateLimit());

  app.use("/api", healthRoutes(db));
  app.use("/api", menuRoutes(services));
  app.use("/api", cartRoutes(services));
  app.use("/api", orderRoutes(services));
  app.use("/api", customerRoutes(services));

  const router = new BusinessRouter(services, ai);
  app.post(config.webhookPath, createZaloWebhookHandler({ repos, services, router }));

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
