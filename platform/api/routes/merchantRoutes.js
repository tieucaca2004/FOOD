import { Router } from "express";

function asyncRoute(fn) {
  return (req, res, next) => fn(req, res, next).catch(next);
}

function requireString(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    const err = new Error(`${field} is required`);
    err.status = 400;
    throw err;
  }
  return value.trim();
}

// Merchant onboarding + admin review API (spec §13/§16). No merchant is
// ever discoverable straight out of onboarding — activate() is a separate,
// explicit admin action.
export function merchantRoutes({ services, repos, registry }) {
  const router = Router();

  router.get("/merchants", (_req, res) => {
    res.json({ merchants: repos.merchants.listAll() });
  });

  router.get("/merchants/:id", (req, res) => {
    const merchant = repos.merchants.getById(req.params.id);
    if (!merchant) return res.status(404).json({ status: "error", error: "not_found" });
    res.json({ merchant, subscription: repos.subscriptions.getActiveByMerchant(req.params.id) });
  });

  router.post(
    "/merchants",
    asyncRoute(async (req, res) => {
      const merchantId = requireString(req.body.merchantId, "merchantId");
      const name = requireString(req.body.name, "name");
      const slug = requireString(req.body.slug, "slug");
      const module = requireString(req.body.module, "module");
      const merchant = services.merchants.onboard({
        merchantId,
        name,
        slug,
        module,
        description: req.body.description,
        address: req.body.address,
        phone: req.body.phone,
        planId: req.body.planId,
      });
      res.status(201).json({ merchant });
    })
  );

  router.patch(
    "/merchants/:id/status",
    asyncRoute(async (req, res) => {
      const action = requireString(req.body.action, "action"); // 'activate' | 'suspend' | 'close'
      let merchant;
      if (action === "activate") merchant = services.merchants.activate(req.params.id);
      else if (action === "suspend") merchant = services.merchants.suspend(req.params.id);
      else if (action === "close") merchant = services.merchants.close(req.params.id);
      else return res.status(400).json({ status: "error", error: "invalid action" });

      registry.invalidate(req.params.id);
      res.json({ merchant });
    })
  );

  return router;
}
