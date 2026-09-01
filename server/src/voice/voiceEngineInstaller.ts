import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { spawnCli } from "../platform/processes.js";
import { ensurePrivateDirectorySync } from "../platform/fileProtection.js";
import { t } from "../i18n.js";

// Pinned official whisper.cpp Windows x64 release. Do not turn this into a
// "latest" lookup: a fixed URL, byte count, and SHA-256 make the consented
// binary download auditable and prevent a moving release from silently
// changing what Pixel Crew installs.
export type VoiceEngineRelease = {
  name: string;
  url: string;
  sha256: string;
  bytes: number;
  executable: string;
};

export const VOICE_ENGINE_WINDOWS_X64: VoiceEngineRelease = {
  name: "whisper.cpp b4938",
  url: "https://github.com/ggml-org/whisper.cpp/releases/download/b4938/whisper-bin-x64.zip",
  sha256: "c2a4b60edb11f7e11a9191ffb50929535527d4d91c9903dbe3e554583bbbc63d",
  bytes: 8_361_840,
  // The official archive keeps the executable and its required DLLs under
  // `Release/`; retaining that directory also keeps Windows DLL resolution
  // beside whisper-server.exe.
  executable: "Release/whisper-server.exe",
};

export type VoiceEngineInstallStatus = "not_supported" | "not_installed" | "downloading" | "ready" | "failed";
export type VoiceEngineInstallInfo = {
  status: VoiceEngineInstallStatus;
  supported: boolean;
  name: string;
  bytesDownloaded: number;
  totalBytes: number;
  error: string | null;
};

type FetchLike = (url: string) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  body: AsyncIterable<Uint8Array> | null;
}>;
type ExtractZip = (archivePath: string, destination: string) => Promise<void>;

export function powerShellExtractionCommand(archivePath: string, destination: string): string {
  // `-Command` consumes every following token as PowerShell source, not as
  // `$args`. Encoding the complete script means paths with spaces (or a user's
  // apostrophe in their profile name) are passed literally on Windows PowerShell
  // 5.1 as well as newer versions.
  const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
  const script = `$ErrorActionPreference = 'Stop'; Expand-Archive -LiteralPath ${literal(archivePath)} -DestinationPath ${literal(destination)} -Force`;
  return Buffer.from(script, "utf16le").toString("base64");
}

function extractWithPowerShell(archivePath: string, destination: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawnCli("powershell.exe", [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-EncodedCommand", powerShellExtractionCommand(archivePath, destination),
    ]);
    child.stdout.resume(); child.stderr.resume();
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error(t("語音轉寫引擎解壓失敗"))));
  });
}

export class VoiceEngineInstaller {
  private state: VoiceEngineInstallInfo;
  private readonly destination: string;
  private readonly archivePath: string;
  private running: Promise<void> | null = null;

  constructor(
    private readonly enginesDir: string,
    private readonly onInstalled: (path: string) => void,
    private readonly fetcher: FetchLike = fetch as unknown as FetchLike,
    private readonly extractZip: ExtractZip = extractWithPowerShell,
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly arch: string = process.arch,
    private readonly release: VoiceEngineRelease = VOICE_ENGINE_WINDOWS_X64,
  ) {
    this.destination = join(enginesDir, "whisper-cpp");
    this.archivePath = join(enginesDir, ".whisper-bin-x64.zip.downloading");
    ensurePrivateDirectorySync(enginesDir);
    const installed = this.installedBinary;
    this.state = installed
      ? this.readyState()
      : this.emptyState();
  }

  get supported(): boolean { return this.platform === "win32" && this.arch === "x64"; }

  get installedBinary(): string | null {
    const path = join(this.destination, this.release.executable);
    try { return statSync(path).isFile() ? path : null; } catch { return null; }
  }

  getInfo(): VoiceEngineInstallInfo { return { ...this.state }; }

  start(): VoiceEngineInstallInfo {
    if (!this.supported || this.installedBinary) return this.state;
    if (!this.running) this.running = this.run().finally(() => { this.running = null; });
    return this.getInfo();
  }

  private emptyState(): VoiceEngineInstallInfo {
    return this.supported
      ? { status: "not_installed", supported: true, name: this.release.name, bytesDownloaded: 0, totalBytes: this.release.bytes, error: null }
      : { status: "not_supported", supported: false, name: this.release.name, bytesDownloaded: 0, totalBytes: this.release.bytes, error: null };
  }

  private readyState(): VoiceEngineInstallInfo {
    return { status: "ready", supported: this.supported, name: this.release.name, bytesDownloaded: this.release.bytes, totalBytes: this.release.bytes, error: null };
  }

  private async run(): Promise<void> {
    const staging = join(this.enginesDir, `.whisper-cpp.staging-${process.pid}`);
    try {
      this.state = { ...this.emptyState(), status: "downloading" };
      const response = await this.fetcher(this.release.url);
      if (!response.ok || !response.body) throw new Error(t("語音轉寫引擎下載連線失敗（HTTP {status}）", { status: response.status }));
      const advertisedBytes = Number(response.headers.get("content-length"));
      if (Number.isFinite(advertisedBytes) && advertisedBytes !== this.release.bytes) throw new Error(t("語音轉寫引擎下載大小不符"));
      const hash = createHash("sha256");
      let bytesDownloaded = 0;
      const file = createWriteStream(this.archivePath, { mode: 0o600 });
      for await (const chunk of response.body) {
        hash.update(chunk); bytesDownloaded += chunk.length;
        this.state = { ...this.emptyState(), status: "downloading", bytesDownloaded };
        await new Promise<void>((resolve, reject) => file.write(chunk, (error) => error ? reject(error) : resolve()));
      }
      await new Promise<void>((resolve, reject) => file.close((error) => error ? reject(error) : resolve()));
      if (bytesDownloaded !== this.release.bytes || hash.digest("hex") !== this.release.sha256) {
        throw new Error(t("語音轉寫引擎完整性驗證失敗，已刪除下載檔案"));
      }
      rmSync(staging, { recursive: true, force: true });
      mkdirSync(staging, { recursive: true, mode: 0o700 });
      await this.extractZip(this.archivePath, staging);
      const binary = join(staging, this.release.executable);
      if (!existsSync(binary) || !statSync(binary).isFile()) throw new Error(t("語音轉寫引擎檔案不完整"));
      // The downloaded archive is verified before extraction. Move its complete
      // sibling DLL set as one directory so the executable never points at a
      // half-installed engine.
      rmSync(this.destination, { recursive: true, force: true });
      renameSync(staging, this.destination);
      this.state = this.readyState();
      this.onInstalled(this.installedBinary!);
    } catch (error) {
      this.state = { ...this.emptyState(), status: "failed", error: (error as Error).message || t("語音轉寫引擎安裝失敗") };
    } finally {
      try { if (existsSync(this.archivePath)) unlinkSync(this.archivePath); } catch { /* best effort temporary-file cleanup */ }
      try { if (existsSync(staging)) rmSync(staging, { recursive: true, force: true }); } catch { /* best effort temporary-file cleanup */ }
    }
  }
}
