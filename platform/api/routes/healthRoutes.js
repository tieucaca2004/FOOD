import { Router } from "express";

export function healthRoutes(db) {
  const router = Router();

  router.get("/health", (_req, res) => res.json({ status: "ok" }));

  router.get("/readiness", (_req, res) => {
    try {
      db.prepare("SELECT 1").get();
      res.json({ status: "ready" });
    } catch (err) {
      res.status(503).json({ status: "not_ready", error: err.message });
    }
  });

  return router;
}
