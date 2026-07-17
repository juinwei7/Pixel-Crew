const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function isAllowedLoopbackHost(host?: string): boolean {
  if (!host) return false;
  try {
    const url = new URL(`http://${host}`);
    return !url.username &&
      !url.password &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash &&
      LOOPBACK_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

export function isAllowedLoopbackOrigin(origin?: string): boolean {
  if (!origin) return true;
  try {
    const url = new URL(origin);
    return !url.username &&
      !url.password &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash &&
      LOOPBACK_HOSTS.has(url.hostname) &&
      (url.protocol === "http:" || url.protocol === "https:");
  } catch {
    return false;
  }
}

/**
 * CORS only controls whether a browser may read a response; it does not reject
 * the request itself. Requiring a loopback Host as well prevents a domain that
 * has been DNS-rebound to 127.0.0.1 from reaching this unauthenticated API.
 */
export function isAllowedLocalRequest(host?: string, origin?: string): boolean {
  return isAllowedLoopbackHost(host) && isAllowedLoopbackOrigin(origin);
}
