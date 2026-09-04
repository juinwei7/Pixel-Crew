import { createConnection } from "node:net";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import { terminalMuxPipeName } from "./terminalMuxPipeName.js";
import { commandInvocation } from "./platform/processes.js";
import { TERMINAL_MUX_PROTOCOL_VERSION } from "./terminalMuxProtocol.js";

export const terminalMuxSocketPath = process.platform === "win32"
  ? terminalMuxPipeName(config.dataDirectory)
  : join(config.dataDirectory, "terminal-mux.sock");

let starting: Promise<void> | null = null;

type DaemonProbe = "compatible" | "incompatible" | "unavailable";

function probeDaemon(): Promise<DaemonProbe> {
  return new Promise((resolve) => {
    const socket = createConnection(terminalMuxSocketPath);
    const requestId = randomUUID(); let buffer = "";
    const finish = (value: DaemonProbe) => { socket.removeAllListeners(); socket.destroy(); resolve(value); };
    socket.once("connect", () => socket.write(`${JSON.stringify({ type: "ping", requestId })}\n`));
    socket.once("error", () => finish("unavailable"));
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8"); const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try {
        const reply = JSON.parse(buffer.slice(0, newline)) as { type?: unknown; requestId?: unknown; protocolVersion?: unknown };
        if (reply.type !== "pong" || reply.requestId !== requestId) { finish("unavailable"); return; }
        finish(reply.protocolVersion === TERMINAL_MUX_PROTOCOL_VERSION ? "compatible" : "incompatible");
      } catch { finish("unavailable"); }
    });
    socket.setTimeout(500, () => finish("unavailable"));
  });
}

/** Ask an older but responsive daemon to release its PTYs, database, and
 * socket before starting the compatible build. This avoids ever creating two
 * mux owners against the same SQLite file. */
function stopIncompatibleDaemon(): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(terminalMuxSocketPath); let buffer = ""; let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      error ? reject(error) : resolve();
    };
    socket.once("connect", () => socket.write(`${JSON.stringify({ type: "shutdown" })}\n`));
    socket.once("error", (error: NodeJS.ErrnoException) => {
      // The incompatible owner may finish or be stopped by another concurrent
      // ensure call between our probe and this connection attempt.
      if (error.code === "ECONNREFUSED" || error.code === "ENOENT") finish();
      else finish(error);
    });
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try {
        const reply = JSON.parse(buffer.slice(0, newline)) as { type?: unknown };
        reply.type === "shutting_down" ? finish() : finish(new Error("Incompatible terminal mux refused shutdown"));
      } catch { finish(new Error("Incompatible terminal mux sent invalid JSON")); }
    });
    socket.setTimeout(3_000, () => finish(new Error("Incompatible terminal mux shutdown timed out")));
  });
}

function daemonEntry(): string {
  const js = fileURLToPath(new URL("./terminalMuxDaemon.js", import.meta.url));
  if (existsSync(js)) return js;
  return fileURLToPath(new URL("./terminalMuxDaemon.ts", import.meta.url));
}

/** Ensure one mux owner is alive; it intentionally outlives a web-server restart. */
export async function ensureTerminalMuxDaemon(): Promise<void> {
  const initialProbe = await probeDaemon();
  if (initialProbe === "compatible") return;
  if (!starting) {
    starting = (async () => {
      // The mux outlives the web process. After an application update it can
      // therefore be healthy but too old to understand new messages (for
      // example `launch`), which previously produced a misleading UI timeout.
      if (initialProbe === "incompatible") await stopIncompatibleDaemon();
      const entry = daemonEntry();
      const usingTs = entry.endsWith(".ts");
      const root = resolve(dirname(fileURLToPath(new URL(import.meta.url))), "../..");
      const command = usingTs ? join(root, "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx") : process.execPath;
      const invocation = commandInvocation(command, [entry]);
      const spawnFailure: { current: Error | null } = { current: null };
      const child = spawn(invocation.file, invocation.args, {
        detached: true, stdio: "ignore", windowsHide: true,
        env: { ...process.env, PIXEL_CREW_DATA_DIR: config.dataDirectory, PIXEL_CREW_MUX_DATA_DIR: config.dataDirectory },
      });
      child.once("error", (error) => { spawnFailure.current = error; });
      child.unref();
      for (let attempt = 0; attempt < 30; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        if (spawnFailure.current) throw new Error(`Terminal mux daemon failed to start: ${spawnFailure.current.message}`);
        if (await probeDaemon() === "compatible") return;
      }
      throw new Error("Terminal mux daemon did not start");
    })().finally(() => { starting = null; });
  }
  return starting;
}

export function connectTerminalMux() { return createConnection(terminalMuxSocketPath); }

/** Asks the daemon to write a transactionally-consistent copy of its own
 * database to `destinationPath` (via SQLite's VACUUM INTO, run synchronously
 * on the daemon's single thread) instead of the caller copying the live
 * file/WAL/SHM out from under a still-running daemon. Returns false only when
 * the daemon explicitly says it has never persisted mux data. */
export async function snapshotTerminalMuxDatabase(destinationPath: string): Promise<boolean> {
  const reply = await terminalMuxRequest({ type: "snapshot", path: destinationPath });
  if (reply.type === "snapshotted") return true;
  if (reply.type === "not_initialized") return false;
  if (reply.type === "error") throw new Error(typeof reply.message === "string" ? reply.message : "Unable to snapshot terminal mux database");
  throw new Error("Terminal mux returned an unexpected snapshot response");
}

/** One-request mux RPC used for durable UI metadata, never for terminal I/O. */
export async function terminalMuxRequest(message: Record<string, unknown>): Promise<Record<string, unknown>> {
  await ensureTerminalMuxDaemon();
  return new Promise((resolve, reject) => {
    const socket = connectTerminalMux(); let buffer = ""; let settled = false;
    const finish = (error?: Error, value?: Record<string, unknown>) => {
      if (settled) return; settled = true; socket.destroy(); error ? reject(error) : resolve(value ?? {});
    };
    socket.setTimeout(3_000, () => finish(new Error("Terminal mux request timed out")));
    socket.once("error", (error) => finish(error));
    socket.on("connect", () => socket.write(`${JSON.stringify(message)}\n`));
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8"); const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try { finish(undefined, JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>); }
      catch { finish(new Error("Terminal mux sent invalid JSON")); }
    });
  });
}
