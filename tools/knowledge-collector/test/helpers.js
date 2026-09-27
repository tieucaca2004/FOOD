// Test helpers: a fake network (no real request is ever made in tests).
export function fakeNetwork(routes) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method ?? "GET", body: options.body ?? null, headers: options.headers ?? {} });
    const route = routes[String(url)] ?? routes[String(url).split("#")[0]];
    if (!route) return new Response("not found", { status: 404, headers: { "content-type": "text/plain" } });
    if (route instanceof Error) throw route;
    const res = new Response(route.body, { status: route.status ?? 200, headers: { "content-type": route.contentType ?? "text/html; charset=utf-8" } });
    Object.defineProperty(res, "url", { value: route.finalUrl ?? String(url) });
    return res;
  };
  return { fetchImpl, calls };
}

export const noWait = async () => {};
