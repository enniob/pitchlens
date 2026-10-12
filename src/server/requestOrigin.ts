/**
 * Next.js may normalize the request URL to its internal listening hostname.
 * The browser's Host header names the actual HTTP origin. Do not trust
 * X-Forwarded-Host here; hosting must preserve and validate Host at the edge.
 */
export function requestOrigin(request: Request): string | null {
  const url = new URL(request.url);
  const host = request.headers.get("host");
  if (!host) return url.origin;
  if (!/^[A-Za-z0-9.\-:\[\]]+$/.test(host)) return null;
  try {
    const external = new URL(`${url.protocol}//${host}`);
    return external.origin;
  } catch { return null; }
}
