import { Router } from "express";
import { logger } from "../../../src/logger.js";

export function healthRoutes(db) {
  const router = Router();

  router.get("/health", (_req, res) => res.json({ status: "ok" }));

  router.get("/readiness", (req, res) => {
    try {
      db.prepare("SELECT 1").get();
      res.json({ status: "ready" });
    } catch (err) {
      // Public route: database errors carry file paths and driver detail.
      logger.error("DB", "platform readiness check failed", { requestId: req.requestId, error: err.message });
      res.status(503).json({ status: "not_ready" });
    }
  });

  return router;
}
