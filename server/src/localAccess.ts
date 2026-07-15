const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function isAllowedLoopbackOrigin(origin?: string): boolean {
  if (!origin) return true;
  try {
    const url = new URL(origin);
    return LOOPBACK_HOSTS.has(url.hostname) && (url.protocol === "http:" || url.protocol === "https:");
  } catch {
    return false;
  }
}
