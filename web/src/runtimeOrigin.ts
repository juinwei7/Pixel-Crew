type RuntimeEnv = {
  DEV?: boolean;
  VITE_SERVER_URL?: string;
  VITE_WS_URL?: string;
};

const viteEnv = (import.meta as unknown as { env?: RuntimeEnv }).env;

/**
 * Vite loads `.env` for both development and production.  The override is a
 * development convenience for a separately-running API; a packaged build is
 * served by Pixel Crew itself and must follow the page's actual origin.
 */
export function runtimeHttpOrigin(browserOrigin: string, env: RuntimeEnv = viteEnv ?? {}): string {
  return (env.DEV ? env.VITE_SERVER_URL?.trim() : "") || browserOrigin;
}

export function runtimeWsOrigin(browserOrigin: string, env: RuntimeEnv = viteEnv ?? {}): string {
  const browserWsOrigin = browserOrigin.replace(/^http/, "ws");
  return (env.DEV ? env.VITE_WS_URL?.trim() : "") || browserWsOrigin;
}
