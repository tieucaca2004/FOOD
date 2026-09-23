import { Router } from "express";
import { merchantAuth } from "../middleware/merchantAuth.js";

function asyncRoute(fn) {
  return (req, res, next) => fn(req, res, next).catch(next);
}

// Merchant Order Visibility / Receive boundary (Phase 7) — authenticated,
// scoped strictly to the caller's own merchant_id (resolved by the auth
// middleware, never from the URL/body). See
// platform/services/merchantOrderService.js for the DTO/security model.
export function merchantOrderRoutes({ merchantOrderService, merchantAuthService }) {
  const router = Router();
  // Scoped to /merchant/* only — this router is mounted at the same
  // shared /api/platform prefix as sibling routers (health, merchants,
  // search); an unscoped router.use() here would intercept every request
  // reaching this router regardless of path, including ones meant for a
  // sibling router mounted after it in app.js.
  router.use("/merchant", merchantAuth(merchantAuthService));

  router.get(
    "/merchant/orders",
    asyncRoute(async (req, res) => {
      const orders = merchantOrderService.listOrders(req.merchantAuth.merchantId);
      res.json({ orders });
    })
  );

  router.get(
    "/merchant/orders/:orderId",
    asyncRoute(async (req, res) => {
      const order = merchantOrderService.getOrder(req.merchantAuth.merchantId, Number(req.params.orderId));
      res.json({ order });
    })
  );

  router.post(
    "/merchant/orders/:orderId/receive",
    asyncRoute(async (req, res) => {
      const order = merchantOrderService.receiveOrder(req.merchantAuth.merchantId, Number(req.params.orderId));
      res.json({ order });
    })
  );

  return router;
}
