import { Router } from "express";
import { asyncRoute, requirePositiveInt, requireString } from "../middleware/validate.js";
import { parseFulfillmentType, parsePhone } from "../../domain/checkoutFields.js";

export function orderRoutes(services) {
  const router = Router();

  // REST callers confirm by calling this endpoint at all — there's no
  // separate "are you sure" round trip like the chat flow, so this creates
  // the order straight to CONFIRMED (server still looks up every price and
  // computes the total itself; client only ever supplies productId+quantity
  // indirectly via the customer's existing cart).
  router.post(
    "/orders",
    asyncRoute(async (req, res) => {
      const customerId = requirePositiveInt(req.body.customerId, "customerId");
      const fulfillmentTypeRaw = requireString(req.body.fulfillmentType, "fulfillmentType");
      const fulfillmentType = ["dine_in", "takeaway", "delivery"].includes(fulfillmentTypeRaw)
        ? fulfillmentTypeRaw
        : parseFulfillmentType(fulfillmentTypeRaw);
      if (!fulfillmentType) {
        return res.status(400).json({ status: "error", error: "invalid fulfillmentType" });
      }

      const customer = services.customers.getById(customerId);
      if (!customer) return res.status(404).json({ status: "error", error: "customer_not_found" });

      const cartView = services.cart.getCart(customerId);
      const order = services.orders.startCheckout(customer, cartView.cart, cartView.items);

      const deliveryFee = Number(services.orders.repos.settings.get("delivery_fee")) || 0;
      services.orders.applyCheckoutField(order, "fulfillment_type", fulfillmentType, deliveryFee);

      if (fulfillmentType === "delivery") {
        const address = requireString(req.body.address, "address");
        services.orders.applyCheckoutField(order, "address", address);
      }

      const phone = req.body.phone ? parsePhone(String(req.body.phone)) : customer.phone;
      if (phone) {
        services.orders.applyCheckoutField(order, "phone", phone);
        services.customers.recordPhone(customerId, phone);
      }

      const refreshed = services.orders.getById(order.id);
      const pending = services.orders.moveToPendingConfirmation(refreshed);
      const confirmed = await services.orders.confirm(pending, cartView.cart);
      res.status(201).json(services.orders.getDetail(confirmed.id));
    })
  );

  router.get(
    "/orders/:id",
    asyncRoute(async (req, res) => {
      const id = requirePositiveInt(req.params.id, "id");
      const detail = services.orders.getDetail(id);
      if (!detail) return res.status(404).json({ status: "error", error: "not_found" });
      res.json(detail);
    })
  );

  // Admin/kitchen use: move an order through ACCEPTED -> PREPARING -> READY
  // -> COMPLETED (or CANCELLED where the state machine allows it).
  router.patch(
    "/orders/:id/status",
    asyncRoute(async (req, res) => {
      const id = requirePositiveInt(req.params.id, "id");
      const status = requireString(req.body.status, "status");
      const order = services.orders.transition(id, status, req.body.note);
      res.json(order);
    })
  );

  return router;
}
