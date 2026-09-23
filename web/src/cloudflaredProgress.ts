import { t } from "./i18n";

// cloudflared 首次下載的進度呈現。轉接站（_tsproxy.mjs）把收到的位元組數／總長度丟過來，
// 這裡只負責換算成畫面上的字串——純函式，好測，也讓元件維持單純。

export type CfProgress = {
  received: number;
  total: number;          // 0 ＝ 對方沒給 content-length
  pct: number | null;     // null ＝ 算不出百分比（沒有總長度）
  bytesPerSec: number;
  etaSec: number | null;
};

export type CfInfo = {
  installed: boolean;
  running: boolean;
  url: string;
  downloading: boolean;
  progress?: CfProgress | null;
  error?: string;
};

export function formatBytes(bytes: number): string {
  const n = Math.max(0, Number(bytes) || 0);
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatEta(seconds: number): string {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  if (s < 60) return t("{s} 秒", { s });
  if (s < 3600) return t("{m} 分鐘", { m: Math.ceil(s / 60) });
  return t("{h} 小時", { h: Math.ceil(s / 3600) });
}

export type DownloadDisplay = {
  pct: number | null;   // null ＝ 不確定進度，進度條走滿並降低不透明度
  headline: string;     // "37%" 或「下載中…」
  size: string;         // "7.1 / 19.2 MB"（沒有總長度時只有已下載量）
  speed: string;        // "1.8 MB/s"，速度還算不出來時為空字串
  eta: string;          // "剩餘約 12 秒"，算不出來時為空字串
};

/** 把轉接站回報的原始數字整理成畫面要的幾行字。info 沒有進度時回傳不確定狀態。 */
export function describeDownload(info: CfInfo | null | undefined): DownloadDisplay {
  const p = info?.progress ?? null;
  const pct = p && typeof p.pct === "number" ? Math.max(0, Math.min(100, p.pct)) : null;
  const received = p ? p.received : 0;
  const total = p ? p.total : 0;
  return {
    pct,
    headline: pct === null ? t("下載中…") : `${pct}%`,
    size: total > 0 ? `${formatBytes(received)} / ${formatBytes(total)}` : formatBytes(received),
    speed: p && p.bytesPerSec > 0 ? t("{rate}/s", { rate: formatBytes(p.bytesPerSec) }) : "",
    eta: p && typeof p.etaSec === "number" ? t("剩餘約 {eta}", { eta: formatEta(p.etaSec) }) : "",
  };
}
