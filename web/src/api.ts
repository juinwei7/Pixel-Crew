const viteEnv = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
const browserOrigin = typeof window !== "undefined" ? window.location.origin : "http://localhost:8787";
const SERVER_URL = viteEnv?.VITE_SERVER_URL?.trim() || browserOrigin;

export function apiAssetUrl(path: string): string {
  return `${SERVER_URL}${path}`;
}

type ApiOptions = Omit<RequestInit, "body"> & {
  body?: unknown;
  timeoutMs?: number;
};

export class ApiRequestError extends Error {
  constructor(message: string, readonly status = 0) {
    super(message);
    this.name = "ApiRequestError";
  }
}

export async function apiRequest<T>(path: string, options: ApiOptions = {}): Promise<T> {
  const controller = new AbortController();
  const { timeoutMs = 15000, body: bodyValue, ...requestInit } = options;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = new Headers(requestInit.headers);
    let body: BodyInit | undefined;
    if (bodyValue !== undefined) {
      headers.set("Content-Type", "application/json");
      body = JSON.stringify(bodyValue);
    }
    const response = await fetch(`${SERVER_URL}${path}`, { ...requestInit, headers, body, signal: controller.signal });
    const data = await response.json().catch(() => ({})) as T & { error?: string };
    if (!response.ok) throw new ApiRequestError(data.error ?? `請求失敗（${response.status}）`, response.status);
    return data;
  } catch (error) {
    if (error instanceof ApiRequestError) throw error;
    if ((error as Error).name === "AbortError") throw new ApiRequestError("伺服器回應逾時，請確認 Pixel Crew Server 是否仍在執行");
    throw new ApiRequestError("無法連線到 Pixel Crew Server，請確認本機服務狀態");
  } finally {
    clearTimeout(timeout);
  }
}
