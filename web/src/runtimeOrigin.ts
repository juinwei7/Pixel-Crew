type RuntimeEnv = {
  DEV?: boolean;
  VITE_SERVER_URL?: string;
  VITE_WS_URL?: string;
};

const viteEnv = (import.meta as unknown as { env?: RuntimeEnv }).env;

function isLoopbackOrigin(origin: string): boolean {
  try {
    const hostname = new URL(origin).hostname.toLowerCase();
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
  } catch {
    return false;
  }
}

/**
 * Vite loads `.env` for both development and production.  The override is a
 * development convenience for a separately-running API; a packaged build is
 * served by Pixel Crew itself and must follow the page's actual origin.
 */
export function runtimeHttpOrigin(browserOrigin: string, env: RuntimeEnv = viteEnv ?? {}): string {
  // A dev override such as http://localhost:8787 is valid only for a browser
  // running on this computer. Through the remote-access tunnel, localhost is
  // the phone itself; keep requests same-origin so the authenticated gateway
  // can forward them to the API instead.
  return (env.DEV && isLoopbackOrigin(browserOrigin) ? env.VITE_SERVER_URL?.trim() : "") || browserOrigin;
}

export function runtimeWsOrigin(browserOrigin: string, env: RuntimeEnv = viteEnv ?? {}): string {
  const browserWsOrigin = browserOrigin.replace(/^http/, "ws");
  return (env.DEV && isLoopbackOrigin(browserOrigin) ? env.VITE_WS_URL?.trim() : "") || browserWsOrigin;
}
