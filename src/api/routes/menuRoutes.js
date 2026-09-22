import { Router } from "express";
import { asyncRoute, requirePositiveInt } from "../middleware/validate.js";

export function menuRoutes(services) {
  const router = Router();

  router.get(
    "/menu",
    asyncRoute(async (req, res) => {
      const includeUnavailable = req.query.includeUnavailable === "true";
      const products = services.menu.repos.products.list({ includeUnavailable });
      res.json({ products });
    })
  );

  router.get(
    "/menu/:id",
    asyncRoute(async (req, res) => {
      const id = requirePositiveInt(req.params.id, "id");
      const product = services.menu.getProductById(id);
      if (!product) return res.status(404).json({ status: "error", error: "not_found" });
      res.json({ product });
    })
  );

  return router;
}
