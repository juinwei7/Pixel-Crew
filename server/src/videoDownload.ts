import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 貼連結看影片：用 yt-dlp 把公開影片（YouTube／抖音/TikTok 等 yt-dlp 支援的站）下載成單一
// 檔案，交回 Buffer，再走既有的 extractVideoFramesAndAudio 抽影格＋whisper 管線——等同讓
// Claude「看＋聽」這支影片。界線：只抓公開內容，不帶 cookie/登入、不繞付費牆或反爬蟲。

export class VideoDownloadError extends Error {}

// yt-dlp 支援的站很多，這裡只擋明顯不是 http(s) 的輸入（避免 file://、管線注入等）。
export function isProbableVideoUrl(raw: string): boolean {
  const value = raw.trim();
  if (!/^https?:\/\//i.test(value)) return false;
  try {
    // eslint-disable-next-line no-new
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

export type DownloadedVideo = { buffer: Buffer; sourceUrl: string };

export async function downloadVideoFromUrl(url: string, opts: {
  ytDlpBin?: string;
  maxBytes?: number;
  timeoutMs?: number;
} = {}): Promise<DownloadedVideo> {
  const target = url.trim();
  if (!isProbableVideoUrl(target)) throw new VideoDownloadError("請提供有效的 http(s) 影片連結");
  const bin = opts.ytDlpBin?.trim() || "yt-dlp";
  const maxBytes = Math.max(1, Math.floor(opts.maxBytes ?? 200 * 1024 * 1024));
  const timeoutMs = Math.max(10_000, Math.floor(opts.timeoutMs ?? 240_000));
  const maxMb = Math.max(1, Math.floor(maxBytes / (1024 * 1024)));
  const dir = await mkdtemp(join(tmpdir(), "pc-ytdl-"));
  try {
    // -f：抓 <=720p 的最佳影像＋最佳音訊（YouTube 高畫質多是影音分離串流，yt-dlp 會用
    //     ffmpeg 合流成單一 mp4）；height<=?720 是「軟性」上限，沒有剛好符合的也不會失敗，
    //     再退到 best。--merge-output-format mp4 確保合流後產出固定 video.mp4。
    //     --max-filesize 讓 yt-dlp 自己擋掉過大的檔（不佔硬碟）。
    const args = [
      "--no-playlist",
      "--no-warnings",
      "--no-progress",
      "--no-cache-dir",
      "-f", `bestvideo[height<=?720]+bestaudio/best[height<=?720]/best`,
      "--merge-output-format", "mp4",
      "--max-filesize", `${maxMb}M`,
      "-o", join(dir, "video.%(ext)s"),
      target,
    ];
    await runYtDlp(bin, args, timeoutMs);
    const files = (await readdir(dir)).filter((name) => name.startsWith("video."));
    if (files.length === 0) {
      // yt-dlp 成功結束卻沒產檔，多半是命中 --max-filesize（影片超過上限被跳過）。
      throw new VideoDownloadError(`這支影片超過 ${maxMb}MB 上限，或沒有可下載的公開畫面`);
    }
    // 正常情況合流後只剩 video.mp4；萬一有殘留分軌檔，優先 mp4、否則挑最大的那個。
    const chosen = files.find((name) => name.endsWith(".mp4")) ?? files.sort()[0];
    const buffer = await readFile(join(dir, chosen));
    if (buffer.length === 0) throw new VideoDownloadError("下載到的影片是空的");
    if (buffer.length > maxBytes) throw new VideoDownloadError(`影片超過 ${maxMb}MB 上限`);
    return { buffer, sourceUrl: target };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => { /* 暫存清理 best-effort */ });
  }
}

function runYtDlp(bin: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, args, { windowsHide: true });
    } catch (error) {
      reject(new VideoDownloadError(mapSpawnError(error as NodeJS.ErrnoException, bin)));
      return;
    }
    let stderr = "";
    let settled = false;
    const finish = (fn: () => void) => { if (settled) return; settled = true; clearTimeout(timer); fn(); };
    const timer = setTimeout(() => finish(() => {
      try { child!.kill("SIGKILL"); } catch { /* already gone */ }
      reject(new VideoDownloadError("下載影片逾時（可能太長或連線太慢）"));
    }), timeoutMs);
    child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); if (stderr.length > 8000) stderr = stderr.slice(-8000); });
    child.on("error", (error) => finish(() => reject(new VideoDownloadError(mapSpawnError(error as NodeJS.ErrnoException, bin)))));
    child.on("close", (code) => finish(() => {
      if (code === 0) { resolve(); return; }
      reject(new VideoDownloadError(cleanYtDlpError(stderr) || `yt-dlp 以代碼 ${code} 結束`));
    }));
  });
}

function mapSpawnError(error: NodeJS.ErrnoException, bin: string): string {
  if (error?.code === "ENOENT") return `找不到 yt-dlp（${bin}）。請先安裝 yt-dlp 或設定 YTDLP_BIN`;
  return error?.message || "yt-dlp 啟動失敗";
}

// yt-dlp 的錯誤訊息常帶一堆前綴/追蹤，挑最後一行有意義的 ERROR 給使用者看。
function cleanYtDlpError(stderr: string): string {
  const lines = stderr.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const errorLine = [...lines].reverse().find((line) => /error/i.test(line));
  const chosen = (errorLine || lines[lines.length - 1] || "").replace(/^ERROR:\s*/i, "").trim();
  return chosen.slice(0, 300);
}
