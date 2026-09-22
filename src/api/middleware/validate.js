// Small hand-rolled validators — request bodies here are just a handful of
// fields, not worth a schema library dependency.

export function requirePositiveInt(value, fieldName) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    const err = new Error(`${fieldName} must be a positive integer`);
    err.status = 400;
    throw err;
  }
  return n;
}

export function requireString(value, fieldName) {
  if (typeof value !== "string" || value.trim() === "") {
    const err = new Error(`${fieldName} is required`);
    err.status = 400;
    throw err;
  }
  return value.trim();
}

export function asyncRoute(fn) {
  return (req, res, next) => fn(req, res, next).catch(next);
}
