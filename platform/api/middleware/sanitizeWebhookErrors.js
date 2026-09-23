// The webhook handler (platform/channel/webhookController.js, Phase 1/2,
// out of Phase 8's scope to modify) catches its own errors internally and
// echoes err.message directly into the HTTP response — bypassing the
// platform's own shared error-sanitization convention (see
// platform/api/middleware/errorHandler.js's platformErrorHandler, which
// never returns raw error text for an unexpected failure). Discovered by
// Phase 8's error-leakage security test (Part 13 M/R).
//
// Closes the gap non-invasively: wraps res.json so any {status:"error"}
// payload leaving this route has its `error` field replaced with a
// generic, safe message — without changing a line of webhookController.js.
// Full detail is still logged server-side (webhookController.js's own
// logger.error call, unaffected) and still stored in
// platform_webhook_events for debugging — only the HTTP response to the
// external caller is redacted.
export function sanitizeWebhookErrors(req, res, next) {
  const originalJson = res.json.bind(res);
  res.json = (payload) => {
    if (payload && payload.status === "error" && typeof payload.error === "string") {
      return originalJson({ ...payload, error: "internal_error" });
    }
    return originalJson(payload);
  };
  next();
}
