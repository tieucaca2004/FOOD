import { Router } from "express";
import { asyncRoute, requirePositiveInt } from "../middleware/validate.js";

export function customerRoutes(services) {
  const router = Router();

  router.get(
    "/customers/:id",
    asyncRoute(async (req, res) => {
      const id = requirePositiveInt(req.params.id, "id");
      const customer = services.customers.getById(id);
      if (!customer) return res.status(404).json({ status: "error", error: "not_found" });
      res.json(customer);
    })
  );

  return router;
}
