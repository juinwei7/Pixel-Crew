import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const isWindows = process.platform === "win32";
const tsx = join(root, "node_modules", ".bin", isWindows ? "tsx.cmd" : "tsx");
const serverDirectory = join(root, "server");

export function restartDelayMs(attempt) {
  return Math.min(5_000, 300 * (2 ** Math.min(attempt, 8)));
}

export function shouldRestart({ stopping, code, signal }) {
  return !stopping && (code !== 0 || signal !== "SIGINT");
}

let child = null;
let stopping = false;
let restartAttempt = 0;

// A run that stays up a while is evidence the backend is healthy again — reset
// the backoff instead of letting it climb toward the cap for the rest of an
// entire dev session over unrelated, sporadic restarts.
const STABLE_RUN_MS = 30_000;

function start() {
  const startedAt = Date.now();
  child = spawn(tsx, ["watch", "src/index.ts"], {
    cwd: serverDirectory,
    stdio: "inherit",
    windowsHide: true,
  });

  // A process can fail to spawn at all (e.g. ENOENT resolving tsx), in which
  // case 'close' is not guaranteed to follow 'error' — without a shared exit
  // path here, the supervisor would keep a dead `child` reference forever
  // with no restart scheduled and no way to exit, silently never serving.
  let settled = false;
  const handleExit = (code, signal) => {
    if (settled) return;
    settled = true;
    const restart = shouldRestart({ stopping, code, signal });
    if (!restart) { process.exit(code ?? 0); return; }
    if (Date.now() - startedAt >= STABLE_RUN_MS) restartAttempt = 0;
    const delay = restartDelayMs(restartAttempt++);
    console.error(`[server-supervisor] 後端已停止（code=${code ?? "none"}, signal=${signal ?? "none"}）；${delay}ms 後重啟。`);
    // Re-check `stopping` at fire time, not just when `close` first arrived:
    // if the whole process group received Ctrl+C at once, this child may
    // exit (code 0, signal null — indistinguishable from a self-requested
    // restart) slightly before the supervisor's own SIGINT handler below has
    // set `stopping`; without re-checking, that race spawns a fresh backend
    // right as the user is trying to quit.
    setTimeout(() => { if (!stopping) start(); }, delay);
  };

  child.once("error", (error) => {
    console.error(`[server-supervisor] 無法啟動後端：${error.message}`);
    handleExit(null, null);
  });
  child.once("close", (code, signal) => handleExit(code, signal));
}

function stop(signal) {
  if (stopping) return;
  stopping = true;
  if (!child || child.exitCode !== null) {
    process.exit(0);
    return;
  }
  child.kill(signal);
  const forceExit = setTimeout(() => child?.kill("SIGKILL"), 3_000);
  child.once("close", () => {
    clearTimeout(forceExit);
    process.exit(0);
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.once("SIGINT", () => stop("SIGINT"));
  process.once("SIGTERM", () => stop("SIGTERM"));
  start();
}
