import { Router } from "express";
import { asyncRoute, requirePositiveInt } from "../middleware/validate.js";

export function cartRoutes(services) {
  const router = Router();

  // Client sends productId + quantity only — price is always looked up
  // server-side inside cartService.addItem. Any price/total field in the
  // body is silently ignored, never trusted.
  router.post(
    "/cart/items",
    asyncRoute(async (req, res) => {
      const customerId = requirePositiveInt(req.body.customerId, "customerId");
      const productId = requirePositiveInt(req.body.productId, "productId");
      const quantity = requirePositiveInt(req.body.quantity, "quantity");
      const result = services.cart.addItem(customerId, productId, quantity);
      res.status(201).json(result);
    })
  );

  router.patch(
    "/cart/items/:id",
    asyncRoute(async (req, res) => {
      const itemId = requirePositiveInt(req.params.id, "id");
      const quantity = requirePositiveInt(req.body.quantity, "quantity");
      const item = services.cart.repos.carts.findItemById(itemId);
      if (!item) return res.status(404).json({ status: "error", error: "not_found" });
      const cart = services.cart.repos.carts.getById(item.cart_id);
      const view = services.cart.updateItemQuantity(cart.customer_id, itemId, quantity);
      res.json(view);
    })
  );

  router.delete(
    "/cart/items/:id",
    asyncRoute(async (req, res) => {
      const itemId = requirePositiveInt(req.params.id, "id");
      const item = services.cart.repos.carts.findItemById(itemId);
      if (!item) return res.status(404).json({ status: "error", error: "not_found" });
      const cart = services.cart.repos.carts.getById(item.cart_id);
      services.cart.removeItemById(cart.customer_id, itemId);
      const view = services.cart.getCart(cart.customer_id);
      res.json(view);
    })
  );

  router.get(
    "/cart/:customerId",
    asyncRoute(async (req, res) => {
      const customerId = requirePositiveInt(req.params.customerId, "customerId");
      res.json(services.cart.getCart(customerId));
    })
  );

  return router;
}
