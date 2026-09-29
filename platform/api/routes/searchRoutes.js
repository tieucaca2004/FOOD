import { Router } from "express";

function asyncRoute(fn) {
  return (req, res, next) => fn(req, res, next).catch(next);
}

// Debug/testing entry point into Discovery without going through chat.
export function searchRoutes(discovery) {
  const router = Router();

  router.get(
    "/search",
    asyncRoute(async (req, res) => {
      const q = String(req.query.q || "").trim();
      if (!q) return res.status(400).json({ status: "error", error: "q is required" });
      const { organic, sponsored } = await discovery.searchByKeywords(q);
      res.json({
        organic: organic.map(serializeCandidate),
        sponsored: sponsored.map(serializeCandidate),
      });
    })
  );

  return router;
}

function serializeCandidate(c) {
  return {
    merchant_id: c.merchant.merchant_id,
    merchant_name: c.merchant.name,
    merchant_status: c.merchant.status,
    matches: c.matches,
    score: c.score,
  };
}
