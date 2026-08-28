import { t } from "./i18n";
import { requestGuardianUnlock } from "./guardianGate";

// 分享訪客碰到受限操作時，轉接站回 403 { error: "guardian_required" }。
// 攔下它、跳監護密碼、成功後重試一次（只重試一次，避免無出口迴圈）。
async function handleGuardian(status: number, error: string | undefined, retried: boolean): Promise<boolean> {
  if (retried || status !== 403 || error !== "guardian_required") return false;
  return requestGuardianUnlock();
}

// 轉接站對分享訪客回的機器碼 → 給人看的訊息。
function friendlyError(error: string | undefined, status: number): string {
  if (error === "owner_only") return t("此操作僅限主人，訪客無法執行");
  if (error === "too_many_attempts") return t("嘗試過於頻繁，請稍後再試");
  return error ?? t("請求失敗（{status}）", { status: String(status) });
}

const viteEnv = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
const browserOrigin = typeof window !== "undefined" ? window.location.origin : "http://localhost:8787";
const SERVER_URL = viteEnv?.VITE_SERVER_URL?.trim() || browserOrigin;

export function apiAssetUrl(path: string): string {
  return `${SERVER_URL}${path}`;
}

type ApiOptions = Omit<RequestInit, "body"> & {
  body?: unknown;
  timeoutMs?: number;
  retried?: boolean; // 內部用：監護解鎖後重試只做一次
};

export class ApiRequestError extends Error {
  constructor(message: string, readonly status = 0) {
    super(message);
    this.name = "ApiRequestError";
  }
}

// Multipart upload — apiRequest always JSON-encodes its body, which isn't
// suitable for a backup archive (base64 inflation + the JSON size cap).
export async function apiUpload<T>(path: string, formData: FormData, opts: { timeoutMs?: number; retried?: boolean } = {}): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 120000);
  try {
    const response = await fetch(`${SERVER_URL}${path}`, { method: "POST", body: formData, signal: controller.signal });
    const data = await response.json().catch(() => ({})) as T & { error?: string };
    if (!response.ok) {
      if (await handleGuardian(response.status, data.error, !!opts.retried)) {
        return apiUpload<T>(path, formData, { ...opts, retried: true });
      }
      throw new ApiRequestError(friendlyError(data.error, response.status), response.status);
    }
    return data;
  } catch (error) {
    if (error instanceof ApiRequestError) throw error;
    if ((error as Error).name === "AbortError") throw new ApiRequestError(t("伺服器回應逾時，請確認 Pixel Crew Server 是否仍在執行"));
    throw new ApiRequestError(t("上傳失敗，請確認 Pixel Crew Server 是否仍在執行"));
  } finally {
    clearTimeout(timeout);
  }
}

export async function apiRequest<T>(path: string, options: ApiOptions = {}): Promise<T> {
  const controller = new AbortController();
  const { timeoutMs = 15000, body: bodyValue, retried, ...requestInit } = options;
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
    if (!response.ok) {
      if (await handleGuardian(response.status, data.error, !!retried)) {
        return apiRequest<T>(path, { ...options, retried: true });
      }
      throw new ApiRequestError(friendlyError(data.error, response.status), response.status);
    }
    return data;
  } catch (error) {
    if (error instanceof ApiRequestError) throw error;
    if ((error as Error).name === "AbortError") throw new ApiRequestError(t("伺服器回應逾時，請確認 Pixel Crew Server 是否仍在執行"));
    throw new ApiRequestError(t("無法連線到 Pixel Crew Server，請確認本機服務狀態"));
  } finally {
    clearTimeout(timeout);
  }
}
