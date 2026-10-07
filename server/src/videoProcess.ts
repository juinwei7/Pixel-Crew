import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 影片處理：Claude 的 API 不吃影片，但吃圖片＋文字。所以用 ffmpeg 把影片切成「均勻分佈
// 的關鍵影格 (JPEG)」＋抽出「16kHz mono WAV 音訊」，影格當圖片、音訊丟 whisper 轉成文字，
// 一起送給 Claude——等效於讓它「看＋聽」影片（做法同 GPT 的影片理解：抽幀＋音訊字幕）。
// 這裡只負責「影片 → 影格 + WAV」；轉文字在 index.ts 用既有的 whisper 引擎做。

export class VideoProcessingError extends Error {}

function run(bin: string, args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, args, { windowsHide: true });
    } catch (error) {
      reject(new VideoProcessingError((error as Error).message));
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (fn: () => void) => { if (settled) return; settled = true; clearTimeout(timer); fn(); };
    const timer = setTimeout(() => finish(() => { try { child!.kill("SIGKILL"); } catch { /* already gone */ } reject(new VideoProcessingError(`${bin} timed out`)); }), timeoutMs);
    child.stdout?.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => finish(() => reject(new VideoProcessingError(error.message))));
    child.on("close", (code) => finish(() => code === 0
      ? resolve({ stdout, stderr })
      : reject(new VideoProcessingError(stderr.trim().slice(-400) || `${bin} exited with ${code}`))));
  });
}

async function probeDurationSeconds(ffprobeBin: string, input: string): Promise<number | null> {
  try {
    const { stdout } = await run(ffprobeBin, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", input], 20_000);
    const duration = Number.parseFloat(stdout.trim());
    return Number.isFinite(duration) && duration > 0 ? duration : null;
  } catch {
    return null; // ffprobe 缺席或探測失敗 → 走固定間隔取樣的後備路徑
  }
}

export type ExtractedVideo = {
  frames: Array<{ name: string; dataBase64: string }>; // JPEG，直接可當 message image
  audioWav: Buffer | null;                             // 16kHz mono，無音軌時為 null
  durationSeconds: number | null;
};

export async function extractVideoFramesAndAudio(video: Buffer, opts: {
  ffmpegBin?: string;
  ffprobeBin?: string;
  maxFrames?: number;
  frameWidth?: number;
} = {}): Promise<ExtractedVideo> {
  const ffmpeg = opts.ffmpegBin?.trim() || "ffmpeg";
  const ffprobe = opts.ffprobeBin?.trim() || "ffprobe";
  const maxFrames = Math.max(1, Math.min(16, Math.floor(opts.maxFrames ?? 8)));
  const width = Math.max(160, Math.min(1280, Math.floor(opts.frameWidth ?? 768)));
  const dir = await mkdtemp(join(tmpdir(), "pc-video-"));
  const input = join(dir, "input");
  try {
    await writeFile(input, video);
    const durationSeconds = await probeDurationSeconds(ffprobe, input);

    // 音訊(→16kHz mono WAV, whisper 要的格式) 與影格「同時」抽——兩個 ffmpeg 並行跑，
    // 省下原本「先音訊、再影格」的循序等待（影片處理更快，體感更接近直接看）。
    const audioPath = join(dir, "audio.wav");
    // 影格：知道時長就均勻取 maxFrames 張（fps=張數/時長）；否則每 3 秒一張、截到 maxFrames。
    const fps = durationSeconds && durationSeconds > 0 ? `${maxFrames}/${durationSeconds}` : "1/3";
    const [audioOk] = await Promise.all([
      run(ffmpeg, ["-nostdin", "-i", input, "-vn", "-ac", "1", "-ar", "16000", "-f", "wav", "-y", audioPath], 180_000)
        .then(() => true).catch(() => false), // 沒音軌/抽取失敗 → audioWav 保持 null
      run(ffmpeg, [
        "-nostdin", "-i", input,
        "-vf", `fps=${fps},scale=${width}:-1:flags=lanczos`,
        "-frames:v", String(maxFrames),
        "-q:v", "3",
        "-y", join(dir, "frame_%03d.jpg"),
      ], 180_000).catch(() => { /* 無視訊軌/抽格失敗 → frames 會是空，下面再判斷 */ }),
    ]);
    let audioWav: Buffer | null = null;
    if (audioOk) {
      audioWav = await readFile(audioPath).catch(() => null);
      if (audioWav && audioWav.length <= 44) audioWav = null; // 只有 WAV 表頭 = 實際上沒聲音
    }

    const files = (await readdir(dir)).filter((name) => name.startsWith("frame_") && name.endsWith(".jpg")).sort();
    const frames: Array<{ name: string; dataBase64: string }> = [];
    for (const [index, file] of files.slice(0, maxFrames).entries()) {
      const buffer = await readFile(join(dir, file));
      if (buffer.length > 0) frames.push({ name: `frame-${index + 1}.jpg`, dataBase64: buffer.toString("base64") });
    }

    if (frames.length === 0 && !audioWav) {
      throw new VideoProcessingError("無法從這個影片取得畫面或聲音（格式可能不支援，或 ffmpeg 未安裝）");
    }
    return { frames, audioWav, durationSeconds };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => { /* 暫存清理為 best-effort */ });
  }
}
