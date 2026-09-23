// Resolves req.merchantAuth = { merchantUserId, merchantId } from a
// verified `Authorization: Bearer <key>` header — the ONLY source of
// merchant_id for every merchant-facing route. A merchant_id in the
// request body/params/query is never trusted as authority (Phase 7
// requirement) — routes must always use req.merchantAuth.merchantId.
export function merchantAuth(merchantAuthService) {
  return function merchantAuthMiddleware(req, res, next) {
    const header = req.headers.authorization || "";
    const [scheme, token] = header.split(" ");
    if (scheme !== "Bearer" || !token) {
      return res.status(401).json({ status: "error", error: "unauthenticated" });
    }
    try {
      req.merchantAuth = merchantAuthService.verifyApiKey(token);
      next();
    } catch (err) {
      return res.status(err.status || 401).json({ status: "error", error: "unauthenticated" });
    }
  };
}
