import { Router } from "express";
import { adminAuth } from "../middleware/adminAuth.js";

function asyncRoute(fn) {
  return (req, res, next) => fn(req, res, next).catch(next);
}

// Admin-only action, behind the platform admin token (see adminAuth.js).
// Mints/rotates the API key a merchant uses against the Phase 7
// merchant-facing routes (merchantOrderRoutes.js).
export function merchantAuthRoutes({ merchantAuthService }) {
  const router = Router();
  router.use("/merchants", adminAuth());

  router.post(
    "/merchants/:id/api-keys",
    asyncRoute(async (req, res) => {
      const result = merchantAuthService.issueApiKey(req.params.id);
      res.status(201).json({ merchant_user_id: result.merchantUserId, merchant_id: result.merchantId, api_key: result.apiKey });
    })
  );

  return router;
}
