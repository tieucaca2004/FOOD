import { Router } from "express";

function asyncRoute(fn) {
  return (req, res, next) => fn(req, res, next).catch(next);
}

// Admin-only action — same unauthenticated trust boundary the existing
// /api/platform/merchants onboarding endpoints already use (see
// merchantRoutes.js). Mints/rotates the API key a merchant uses against
// the Phase 7 merchant-facing routes (merchantOrderRoutes.js). Phase 7
// does not introduce a new admin-authentication system — only a
// merchant one.
export function merchantAuthRoutes({ merchantAuthService }) {
  const router = Router();

  router.post(
    "/merchants/:id/api-keys",
    asyncRoute(async (req, res) => {
      const result = merchantAuthService.issueApiKey(req.params.id);
      res.status(201).json({ merchant_user_id: result.merchantUserId, merchant_id: result.merchantId, api_key: result.apiKey });
    })
  );

  return router;
}
