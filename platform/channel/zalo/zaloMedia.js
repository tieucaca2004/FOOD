// Zalo OA image download (customer contributions). The event shape (user_send_image -> message.attachments[]
// {type:"image", payload:{url, thumbnail}}) was checked on 2026-09-27 against a production integration's schema
// (ChatbotX integrations/zalo/src/schema/webhook.ts, which also fetches payload.url directly); the official
// developers.zalo.me page is script-rendered and could not be read, and no OA credentials exist here — so a LIVE
// Zalo check is still pending (see the V1 report).
//
// SSRF guard: https only, host must end with an allowed Zalo CDN suffix, redirects followed only to allowed hosts
// (at most 2), size cap while reading, timeout. Nothing from the URL is ever logged (it is a signed link).

export function isAllowedZaloUrl(raw, hosts) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" || u.username || u.password || (u.port && u.port !== "443")) return false;
  const host = u.hostname.toLowerCase();
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":")) return false; // no IP literals
  return hosts.some((h) => host === h || host.endsWith(`.${h}`));
}

/**
 * @param {{hosts: string[], fetchImpl?: Function, maxBytes?: number, timeoutMs?: number}} opts
 * @returns {(url: string) => Promise<{buffer: Buffer, mimeType: string|null}>}
 */
export function zaloMediaFetcher({ hosts, fetchImpl = globalThis.fetch, maxBytes = 10 * 1024 * 1024, timeoutMs = 20000 }) {
  return async function fetchZaloMedia(url) {
    let target = url;
    for (let hop = 0; hop < 3; hop++) {
      if (!isAllowedZaloUrl(target, hosts)) throw Object.assign(new Error("zalo media url not allowed"), { permanent: true });
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetchImpl(target, { redirect: "manual", signal: controller.signal, headers: { "user-agent": "FOOD-contributions/1.0" } });
        if (res.status >= 300 && res.status < 400) {
          const next = res.headers.get("location");
          if (!next) throw new Error(`zalo media redirect without location (HTTP ${res.status})`);
          target = new URL(next, target).toString();
          continue;
        }
        if (!res.ok) throw new Error(`zalo media download failed (HTTP ${res.status})`);
        const declared = Number(res.headers.get("content-length") || 0);
        if (declared > maxBytes) throw Object.assign(new Error(`media too large (${declared} bytes)`), { permanent: true });
        const reader = res.body?.getReader?.();
        if (!reader) {
          const buffer = Buffer.from(await res.arrayBuffer());
          if (buffer.length > maxBytes) throw Object.assign(new Error(`media too large (${buffer.length} bytes)`), { permanent: true });
          return { buffer, mimeType: res.headers.get("content-type")?.split(";")[0] ?? null };
        }
        const chunks = [];
        let total = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.length;
          if (total > maxBytes) {
            await reader.cancel().catch(() => {});
            throw Object.assign(new Error(`media too large (> ${maxBytes} bytes)`), { permanent: true });
          }
          chunks.push(Buffer.from(value));
        }
        return { buffer: Buffer.concat(chunks), mimeType: res.headers.get("content-type")?.split(";")[0] ?? null };
      } catch (err) {
        if (err.name === "AbortError") throw new Error("zalo media download timed out");
        throw err;
      } finally {
        clearTimeout(timer);
      }
    }
    throw new Error("zalo media: too many redirects");
  };
}
