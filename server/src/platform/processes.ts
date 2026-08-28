import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, extname, isAbsolute, join, win32 } from "node:path";
import crossSpawn from "cross-spawn";
import { t } from "../i18n.js";

type Invocation = { file: string; args: string[]; resolvedExecutable: string };

function windowsExtensions(env: NodeJS.ProcessEnv): string[] {
  const values = (env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  return values.map((value) => value.startsWith(".") ? value.toLowerCase() : `.${value.toLowerCase()}`);
}

export function resolveExecutable(
  command: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  canAccess: (path: string) => boolean = existsSync,
): string {
  const hasPath = isAbsolute(command) || /[\\/]/.test(command);
  const pathDelimiter = platform === "win32" ? ";" : delimiter;
  const paths = hasPath ? [""] : (env.PATH || "").split(pathDelimiter).filter(Boolean);
  const extensions = platform === "win32" && !extname(command) ? ["", ...windowsExtensions(env)] : [""];
  for (const directory of paths) {
    for (const extension of extensions) {
      const candidate = directory
        ? (platform === "win32" ? win32.join(directory, `${command}${extension}`) : join(directory, `${command}${extension}`))
        : `${command}${extension}`;
      if (canAccess(candidate)) return candidate;
    }
  }
  return command;
}

export function quoteWindowsCmdArgument(value: string): string {
  if (/[\r\n\0]/.test(value)) throw new Error(t("Windows 指令參數包含不安全的換行字元"));
  // cmd expands percent variables even inside quotes. Doubling them keeps
  // literal percent signs when invoking npm-generated .cmd shims.
  const escapedPercent = value.replaceAll("%", "%%");
  const escapedQuotes = escapedPercent.replace(/(\\*)"/g, "$1$1\\\"");
  const escapedTrailingSlashes = escapedQuotes.replace(/(\\+)$/, "$1$1");
  return `"${escapedTrailingSlashes}"`;
}

export function commandInvocation(
  command: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  canAccess: (path: string) => boolean = existsSync,
): Invocation {
  const resolvedExecutable = resolveExecutable(command, platform, env, canAccess);
  if (platform === "win32" && [".cmd", ".bat"].includes(extname(resolvedExecutable).toLowerCase())) {
    const comspec = env.ComSpec || env.COMSPEC || "cmd.exe";
    const line = [resolvedExecutable, ...args].map(quoteWindowsCmdArgument).join(" ");
    return { file: comspec, args: ["/d", "/s", "/c", line], resolvedExecutable };
  }
  return { file: resolvedExecutable, args, resolvedExecutable };
}

export function spawnCli(command: string, args: string[], options: SpawnOptionsWithoutStdio = {}): ChildProcessWithoutNullStreams {
  // cross-spawn performs the platform-specific PATHEXT, shebang and npm .cmd
  // shim handling while preserving an argument array and shell:false.
  return crossSpawn(command, args, { ...options, shell: false, stdio: "pipe" }) as ChildProcessWithoutNullStreams;
}

export type ExecCliResult = { stdout: string; stderr: string };

export function execCli(
  command: string,
  args: string[],
  options: SpawnOptionsWithoutStdio & { timeout?: number; maxBuffer?: number } = {},
): Promise<ExecCliResult> {
  const { timeout = 0, maxBuffer = 2 * 1024 * 1024, ...spawnOptions } = options;
  return new Promise((resolve, reject) => {
    const child = spawnCli(command, args, spawnOptions);
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error?: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) {
        Object.assign(error, { stdout, stderr });
        reject(error);
      } else resolve({ stdout, stderr });
    };
    const append = (target: "stdout" | "stderr", chunk: Buffer | string) => {
      const next = (target === "stdout" ? stdout : stderr) + chunk.toString();
      if (Buffer.byteLength(next) > maxBuffer) {
        void terminateProcessTree(child);
        const error = new Error(t("CLI {target} 超過 {maxBuffer} bytes", { target, maxBuffer })) as NodeJS.ErrnoException;
        error.code = "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
        finish(error);
        return;
      }
      if (target === "stdout") stdout = next;
      else stderr = next;
    };
    child.stdout?.on("data", (chunk) => append("stdout", chunk));
    child.stderr?.on("data", (chunk) => append("stderr", chunk));
    child.on("error", (error) => finish(error as NodeJS.ErrnoException));
    child.on("close", (code, signal) => {
      if (code === 0) finish();
      else {
        const error = new Error(stderr.trim() || `CLI exited with code ${code ?? signal}`) as NodeJS.ErrnoException;
        error.code = code == null ? "ERR_CHILD_PROCESS_SIGNAL" : String(code);
        finish(error);
      }
    });
    const timer = timeout > 0 ? setTimeout(() => {
      void terminateProcessTree(child);
      const error = new Error(`CLI request timed out after ${timeout}ms`) as NodeJS.ErrnoException;
      error.code = "ETIMEDOUT";
      finish(error);
    }, timeout) : null;
    timer?.unref();
  });
}

export function processTreeInvocation(pid: number, platform: NodeJS.Platform = process.platform): { file: string; args: string[] } | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  return platform === "win32"
    ? { file: "taskkill.exe", args: ["/PID", String(pid), "/T", "/F"] }
    : null;
}

// POSIX 沒有 taskkill /T 的對應物；SIGTERM 只送到直屬子行程，CLI 底下的
// MCP 孫行程會變孤兒繼續佔資源。這裡用 pgrep -P 逐層列出後代（macOS 與
// Linux 都內建），在殺掉父行程「之前」收集完（父死後子會被 init 收養，
// pgrep -P 就找不到了），再逐一送 SIGTERM。
export async function listPosixDescendants(
  pid: number,
  listChildren: (parent: number) => Promise<number[]> = pgrepChildren,
): Promise<number[]> {
  const collected: number[] = [];
  const seen = new Set<number>([pid]);
  const queue = [pid];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const child of await listChildren(current)) {
      if (!Number.isInteger(child) || child <= 0 || seen.has(child)) continue;
      seen.add(child);
      collected.push(child);
      queue.push(child);
    }
  }
  return collected;
}

function pgrepChildren(parent: number): Promise<number[]> {
  return new Promise((resolve) => {
    const pgrep = spawn("pgrep", ["-P", String(parent)], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    pgrep.stdout?.on("data", (chunk) => { out += chunk.toString(); });
    pgrep.once("error", () => resolve([]));
    pgrep.once("close", () => resolve(out.split("\n").map((line) => Number(line.trim())).filter((n) => Number.isInteger(n) && n > 0)));
  });
}

export async function terminateProcessTree(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.killed) return;
  try { child.stdin?.end(); } catch { /* already closed */ }
  const tree = processTreeInvocation(child.pid);
  if (!tree) {
    const descendants = await listPosixDescendants(child.pid).catch(() => [] as number[]);
    child.kill("SIGTERM");
    for (const pid of descendants) {
      try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
    }
    return;
  }
  await new Promise<void>((resolve) => {
    const killer = spawn(tree.file, tree.args, { windowsHide: true, stdio: "ignore" });
    killer.once("error", () => {
      try { child.kill(); } catch { /* process already stopped */ }
      resolve();
    });
    killer.once("close", () => resolve());
  });
}
