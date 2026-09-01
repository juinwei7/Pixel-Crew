import { connect as netConnect } from "node:net";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawnCli, terminateProcessTree } from "../platform/processes.js";
import { t } from "../i18n.js";

// whisper-cli 重新載入模型＋編譯 Metal shader 每次呼叫都要吃掉 2＋ 秒（見
// LOCAL-VOICE-INPUT-SPEC.md §10），無法穩定達成「停止錄音到草稿可用 3 秒內」的目標。
// 改成常駐的 whisper-server 子行程，模型只在啟動時載入一次，之後單次請求維持
// spike 實測的 0.5–1.6 秒。§4「模型載入與推論不得阻塞既有 CLI/聊天送出」也因此
// 更容易滿足——常駐行程本身跟主行程的事件迴圈完全分離。
export type VoiceEngine = {
  readonly available: boolean;
  readonly baseUrl: string;
  ensureStarted(): Promise<void>;
};

export class VoiceEngineServer implements VoiceEngine {
  private child: ChildProcessWithoutNullStreams | null = null;
  private starting: Promise<void> | null = null;

  constructor(
    private readonly whisperServerBin: string | null,
    private readonly port: number,
    private readonly modelPathProvider: () => string,
    private readonly startupTimeoutMs = 30_000,
  ) {}

  get available(): boolean {
    return this.whisperServerBin !== null;
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  private isAlive(): Promise<boolean> {
    return new Promise((resolve) => {
      const sock = netConnect({ host: "127.0.0.1", port: this.port });
      let settled = false;
      const done = (value: boolean) => {
        if (settled) return;
        settled = true;
        try { sock.destroy(); } catch { /* already gone */ }
        resolve(value);
      };
      sock.setTimeout(800);
      sock.once("connect", () => done(true));
      sock.once("timeout", () => done(false));
      sock.once("error", () => done(false));
    });
  }

  async ensureStarted(): Promise<void> {
    if (!this.whisperServerBin) throw new Error(t("找不到本機語音轉寫引擎"));
    if (await this.isAlive()) return;
    if (!this.starting) this.starting = this.spawnAndWait().finally(() => { this.starting = null; });
    return this.starting;
  }

  private async spawnAndWait(): Promise<void> {
    if (await this.isAlive()) return;
    const child = spawnCli(this.whisperServerBin!, [
      "-m", this.modelPathProvider(),
      "--host", "127.0.0.1",
      "--port", String(this.port),
    ]);
    this.child = child;
    child.stdout?.resume();
    child.stderr?.resume();
    child.once("exit", () => { if (this.child === child) this.child = null; });
    const deadline = Date.now() + this.startupTimeoutMs;
    while (Date.now() < deadline) {
      if (await this.isAlive()) return;
      if (child.exitCode !== null) throw new Error(t("語音轉寫引擎啟動失敗"));
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    throw new Error(t("語音轉寫引擎啟動逾時"));
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.child = null;
    if (child) await terminateProcessTree(child);
  }
}
