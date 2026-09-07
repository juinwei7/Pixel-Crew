/**
 * Pixel Crew's local terminal multiplexer.
 *
 * This deliberately has no HTTP listener.  It owns real OS PTYs and exposes
 * a small JSON-lines protocol over a 0600 Unix-domain socket.  The web server
 * merely brokers a browser attachment, so reloading/restarting that server
 * cannot take down a user's shell or interactive CLI.
 */
import { createConnection, createServer, type Socket } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { chmodSync, existsSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn, type IPty } from "node-pty";
import { ensurePrivateDirectorySync, protectFileSync } from "./platform/fileProtection.js";
import { terminalMuxPipeName } from "./terminalMuxPipeName.js";
import { terminalLaunchCommand } from "./terminalLaunch.js";
import { terminalClientBufferWouldOverflow } from "./terminalFlowControl.js";
import { TERMINAL_MUX_PROTOCOL_VERSION } from "./terminalMuxProtocol.js";

const MAX_INPUT_BYTES = 64_000;
const MAX_SCROLLBACK_BYTES = 1_500_000;
const MAX_COLS = 500;
const MAX_ROWS = 300;
const MAX_AGENT_COMPLETION_TAIL = 65_536;
const dataDirectory = process.env.PIXEL_CREW_DATA_DIR?.trim() || process.env.PIXEL_CREW_MUX_DATA_DIR?.trim();

if (!dataDirectory) throw new Error("PIXEL_CREW_DATA_DIR is required to run terminal mux daemon");

const socketPath = process.platform === "win32"
  ? terminalMuxPipeName(dataDirectory)
  : join(dataDirectory, "terminal-mux.sock");
const databasePath = join(dataDirectory, "terminal-mux.sqlite");

type Input =
  | { type: "ping"; requestId?: string }
  | { type: "attach"; tabId: unknown; workspacePath: unknown; cols: unknown; rows: unknown; launchCommand?: unknown }
  | { type: "input"; data: unknown }
  | { type: "resize"; cols: unknown; rows: unknown }
  | { type: "interrupt" }
  | { type: "configure"; launchCommand: unknown }
  | { type: "launch"; launchCommand: unknown }
  | { type: "layout_get" }
  | { type: "layout_save"; layout: unknown; expectedVersion?: unknown }
  | { type: "checkpoint" }
  | { type: "snapshot"; path: unknown }
  | { type: "detach" }
  | { type: "shutdown" }
  | { type: "destroy"; tabId: unknown }
  | { type: "terminal_get"; tabId: unknown }
  | { type: "claim" };

type TerminalRecord = { id: string; cwd: string; launchCommand: string | null; state: string; scrollback: string; createdAt: string; updatedAt: string };
type RunningTerminal = { record: TerminalRecord; pty: IPty; clients: Set<Client>; writer: Client | null; flushTimer: NodeJS.Timeout | null; deleted: boolean; agentToken: string | null; agentCompletionTail: string };
type Client = { id: string; socket: Socket; buffer: string; terminal: RunningTerminal | null; cols: number; rows: number };

const terminals = new Map<string, RunningTerminal>();
const require = createRequire(import.meta.url);
ensurePrivateDirectorySync(dataDirectory);
const db = new DatabaseSync(databasePath);
protectFileSync(databasePath);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;
  CREATE TABLE IF NOT EXISTS mux_terminal_tabs (
    id TEXT PRIMARY KEY,
    cwd TEXT NOT NULL,
    launch_command TEXT,
    state TEXT NOT NULL,
    scrollback TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS mux_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;
`);

function send(client: Client, payload: unknown): void {
  if (client.socket.destroyed) return;
  const frame = `${JSON.stringify(payload)}\n`;
  if (terminalClientBufferWouldOverflow(client.socket.writableLength, Buffer.byteLength(frame))) {
    client.socket.destroy();
    return;
  }
  try { client.socket.write(frame); } catch { client.socket.destroy(); }
}

function broadcast(terminal: RunningTerminal, payload: unknown): void {
  for (const client of terminal.clients) send(client, payload);
}

function announceWriter(terminal: RunningTerminal): void {
  for (const client of terminal.clients) send(client, { type: "access", writable: terminal.writer === client });
}

function valueString(value: unknown, limit = 8_000): string | null {
  return typeof value === "string" && value.length <= limit ? value : null;
}

function tabId(value: unknown): string | null {
  const id = valueString(value, 160);
  return id && /^terminal-[a-zA-Z0-9-]{8,120}$/.test(id) ? id : null;
}

function dimension(value: unknown, fallback: number, maximum: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= maximum ? value : fallback;
}

function environment(): Record<string, string> {
  return Object.entries(process.env).reduce<Record<string, string>>((result, [key, value]) => {
    if (value !== undefined) result[key] = value;
    return result;
  }, { TERM: "xterm-256color", COLORTERM: "truecolor", TERM_PROGRAM: "Pixel Crew", TERM_PROGRAM_VERSION: "2.3.0" });
}

function shellCommand(): { file: string; args: string[]; shell: string } {
  if (process.platform === "win32") {
    const shell = process.env.ComSpec || "cmd.exe";
    return { file: shell, args: ["/Q", "/K"], shell };
  }
  const shell = process.env.SHELL || "/bin/sh";
  return { file: shell, args: ["-il"], shell };
}

function ensureMacPtyHelperIsExecutable(): void {
  if (process.platform !== "darwin") return;
  try {
    const entry = require.resolve("node-pty");
    const helper = join(dirname(entry), "..", "prebuilds", `darwin-${process.arch}`, "spawn-helper");
    if (existsSync(helper)) chmodSync(helper, 0o755);
  } catch { /* node-pty provides a useful error if the binary is absent. */ }
}

function row(id: string): TerminalRecord | null {
  const result = db.prepare("SELECT id, cwd, launch_command, state, scrollback, created_at, updated_at FROM mux_terminal_tabs WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  return result ? {
    id: String(result.id), cwd: String(result.cwd), launchCommand: result.launch_command == null ? null : String(result.launch_command),
    state: String(result.state), scrollback: String(result.scrollback ?? ""), createdAt: String(result.created_at), updatedAt: String(result.updated_at),
  } : null;
}

function save(record: TerminalRecord): void {
  db.prepare(`INSERT INTO mux_terminal_tabs (id, cwd, launch_command, state, scrollback, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET cwd = excluded.cwd, launch_command = excluded.launch_command, state = excluded.state, scrollback = excluded.scrollback, updated_at = excluded.updated_at`)
    .run(record.id, record.cwd, record.launchCommand, record.state, record.scrollback, record.createdAt, record.updatedAt);
}

function flush(terminal: RunningTerminal): void {
  if (terminal.flushTimer) clearTimeout(terminal.flushTimer);
  terminal.flushTimer = null;
  terminal.record.updatedAt = new Date().toISOString();
  save(terminal.record);
}

function scheduleFlush(terminal: RunningTerminal): void {
  if (!terminal.flushTimer) terminal.flushTimer = setTimeout(() => flush(terminal), 350);
}

function closeTerminal(terminal: RunningTerminal, state: string): void {
  flush(terminal);
  terminal.record.state = state;
  terminal.record.updatedAt = new Date().toISOString();
  save(terminal.record);
  terminals.delete(terminal.record.id);
  terminal.writer = null;
  for (const client of terminal.clients) client.terminal = null;
  terminal.clients.clear();
}

function detectAgentCompletion(terminal: RunningTerminal, data: string): void {
  const token = terminal.agentToken;
  if (!token) return;
  const prefix = `\u001b]777;pixel-crew-agent-exit;${token};`;
  const combined = terminal.agentCompletionTail + data;
  const start = combined.indexOf(prefix);
  const end = start < 0 ? -1 : combined.indexOf("\u0007", start + prefix.length);
  if (start < 0 || end < 0) {
    // Once the prefix itself has been seen, keep everything from that point
    // on instead of a fixed-size suffix — trimming to the last N bytes here
    // could cut the prefix away again before its terminator lands in a later
    // chunk. Still bounded so a terminator that never arrives cannot grow
    // this without limit.
    const tail = start >= 0 ? combined.slice(start) : combined.slice(-256);
    terminal.agentCompletionTail = tail.length > MAX_AGENT_COMPLETION_TAIL ? "" : tail;
    return;
  }
  const rawCode = combined.slice(start + prefix.length, end);
  const parsed = /^-?\d+$/.test(rawCode) ? Number(rawCode) : Number.NaN;
  const code = Number.isSafeInteger(parsed) ? parsed : null;
  terminal.agentToken = null;
  terminal.agentCompletionTail = "";
  terminal.record.launchCommand = null;
  // Keep the private OSC marker out of durable scrollback. xterm ignores the
  // unknown sequence live, but a restored pane should not replay protocol data.
  const persistedStart = terminal.record.scrollback.lastIndexOf(prefix);
  if (persistedStart >= 0) {
    const persistedEnd = terminal.record.scrollback.indexOf("\u0007", persistedStart + prefix.length);
    if (persistedEnd >= 0) terminal.record.scrollback = terminal.record.scrollback.slice(0, persistedStart) + terminal.record.scrollback.slice(persistedEnd + 1);
  }
  flush(terminal);
  broadcast(terminal, { type: "agent_exit", code });
}

function makeTerminal(record: TerminalRecord, cols: number, rows: number): RunningTerminal {
  const command = shellCommand();
  let pty: IPty;
  try {
    ensureMacPtyHelperIsExecutable();
    pty = spawn(command.file, command.args, { cwd: record.cwd, name: "xterm-256color", cols, rows, env: environment(), useConpty: process.platform === "win32" });
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : "Unable to start terminal");
  }
  let agentToken = record.launchCommand ? randomUUID() : null;
  let recoveryLaunch = record.launchCommand && agentToken ? terminalLaunchCommand(record.launchCommand, process.platform, agentToken) : null;
  if (record.launchCommand && !recoveryLaunch) { record.launchCommand = null; agentToken = null; }
  const terminal: RunningTerminal = { record: { ...record, state: "running" }, pty, clients: new Set(), writer: null, flushTimer: null, deleted: false, agentToken, agentCompletionTail: "" };
  terminals.set(record.id, terminal);
  save(terminal.record);
  pty.onData((data) => {
    terminal.record.scrollback = (terminal.record.scrollback + data).slice(-MAX_SCROLLBACK_BYTES);
    scheduleFlush(terminal);
    broadcast(terminal, { type: "output", data });
    detectAgentCompletion(terminal, data);
  });
  pty.onExit(({ exitCode, signal }) => {
    if (terminal.deleted) return;
    broadcast(terminal, { type: "exit", code: exitCode, signal });
    closeTerminal(terminal, "exited");
  });
  // Feeding the command through the interactive shell preserves the exact
  // environment and capabilities of a normal terminal.  It is persisted for
  // reboot recovery, never interpreted by the web client.
  if (recoveryLaunch) pty.write(`${recoveryLaunch}\r`);
  return terminal;
}

function detach(client: Client): void {
  const terminal = client.terminal;
  if (!terminal) return;
  terminal.clients.delete(client);
  if (terminal.writer === client) {
    // Mirror attach()'s own rule: only an explicit claim (or the first-ever
    // attach) may hand write access to a specific client. Auto-promoting
    // whichever viewer happens to still be attached would reflow the PTY to
    // an arbitrary tab's size behind the interactive program's back.
    terminal.writer = null;
    announceWriter(terminal);
  }
  client.terminal = null;
}

function attach(client: Client, message: Extract<Input, { type: "attach" }>): void {
  const id = tabId(message.tabId);
  const cwd = valueString(message.workspacePath, 4_000);
  const launchCommand = message.launchCommand === undefined ? undefined : valueString(message.launchCommand, 8_000);
  if (!id || !cwd) { send(client, { type: "error", message: "Invalid terminal tab or workspace" }); return; }
  detach(client);
  let terminal = terminals.get(id);
  let record = row(id);
  const restored = Boolean(record);
  const now = new Date().toISOString();
  client.cols = dimension(message.cols, 100, MAX_COLS);
  client.rows = dimension(message.rows, 30, MAX_ROWS);
  if (!record) record = { id, cwd, launchCommand: launchCommand ?? null, state: "created", scrollback: "", createdAt: now, updatedAt: now };
  else {
    // The workspace path is layout-owned, but an existing terminal's Agent
    // lifecycle is daemon-owned. A stale browser snapshot must not re-arm a
    // command that already completed while every browser was disconnected.
    record.cwd = cwd;
  }
  try {
    if (!terminal) terminal = makeTerminal(record, client.cols, client.rows);
    else {
      // The live PTY cannot retroactively change directory just because a
      // pane re-attaches with a different workspacePath — only the
      // persisted launch-command recovery hint follows that edit for an
      // already-running terminal. A real cwd change needs a new terminal id.
      terminal.record.launchCommand = record.launchCommand;
      terminal.record.updatedAt = now;
      save(terminal.record);
      // A read-only viewer must not reflow the interactive program under the
      // current writer. Keep this client's size for a later explicit claim.
      if (terminal.writer === client) terminal.pty.resize(client.cols, client.rows);
    }
  } catch (error) { send(client, { type: "error", message: error instanceof Error ? error.message : "Unable to start terminal" }); return; }
  const firstClient = terminal.clients.size === 0;
  terminal.clients.add(client);
  // Attaching (including a reconnect) must never silently steal input from
  // whoever already holds it — only an explicit "claim" does that. The first
  // client to ever attach still becomes the writer since there is no one to
  // take control from.
  if (!terminal.writer && firstClient) {
    terminal.writer = client;
    terminal.pty.resize(client.cols, client.rows);
  }
  client.terminal = terminal;
  send(client, { type: "ready", workspacePath: terminal.record.cwd, shell: shellCommand().shell, pid: terminal.pty.pid, persistent: true, restored, writable: terminal.writer === client, agentRunning: Boolean(terminal.agentToken) });
  announceWriter(terminal);
  if (terminal.record.scrollback) send(client, { type: "output", data: terminal.record.scrollback });
}

function handle(client: Client, message: Input): void {
  if (message.type === "ping") { send(client, { type: "pong", requestId: message.requestId, protocolVersion: TERMINAL_MUX_PROTOCOL_VERSION }); return; }
  if (message.type === "layout_get") {
    const result = db.prepare("SELECT value FROM mux_meta WHERE key = 'black_window_layout'").get() as { value?: unknown } | undefined;
    const revision = db.prepare("SELECT value FROM mux_meta WHERE key = 'black_window_layout_revision'").get() as { value?: unknown } | undefined;
    send(client, { type: "layout", layout: typeof result?.value === "string" ? result.value : null, version: Number.isSafeInteger(Number(revision?.value)) ? Number(revision?.value) : 0 });
    return;
  }
  if (message.type === "layout_save") {
    let serialized: string;
    try { serialized = JSON.stringify(message.layout); } catch { send(client, { type: "error", message: "Invalid terminal layout" }); return; }
    if (!serialized || Buffer.byteLength(serialized, "utf8") > 750_000) { send(client, { type: "error", message: "Terminal layout is too large" }); return; }
    const current = db.prepare("SELECT value FROM mux_meta WHERE key = 'black_window_layout_revision'").get() as { value?: unknown } | undefined;
    const version = Number.isSafeInteger(Number(current?.value)) ? Number(current?.value) : 0;
    if (!Number.isSafeInteger(message.expectedVersion) || message.expectedVersion !== version) {
      const layout = db.prepare("SELECT value FROM mux_meta WHERE key = 'black_window_layout'").get() as { value?: unknown } | undefined;
      send(client, { type: "layout_conflict", layout: typeof layout?.value === "string" ? layout.value : null, version });
      return;
    }
    const nextVersion = version + 1;
    const updatedAt = new Date().toISOString();
    db.prepare("INSERT INTO mux_meta (key, value, updated_at) VALUES ('black_window_layout', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
      .run(serialized, updatedAt);
    db.prepare("INSERT INTO mux_meta (key, value, updated_at) VALUES ('black_window_layout_revision', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
      .run(String(nextVersion), updatedAt);
    send(client, { type: "layout_saved", version: nextVersion });
    return;
  }
  if (message.type === "checkpoint") { for (const terminal of terminals.values()) flush(terminal); db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); send(client, { type: "checkpointed" }); return; }
  if (message.type === "snapshot") {
    const path = valueString(message.path, 4_000);
    if (!path || !isAbsolute(path)) { send(client, { type: "error", message: "Invalid snapshot path" }); return; }
    for (const terminal of terminals.values()) flush(terminal);
    try {
      const tab = db.prepare("SELECT 1 FROM mux_terminal_tabs LIMIT 1").get();
      const metadata = db.prepare("SELECT 1 FROM mux_meta LIMIT 1").get();
      if (!tab && !metadata) { send(client, { type: "not_initialized" }); return; }
      // VACUUM INTO runs synchronously on this single-threaded daemon, so no
      // PTY output or layout_save handler can interleave mid-copy — the
      // destination file is a fully consistent snapshot the instant this
      // call returns, unlike a plain file copy racing a live writer.
      rmSync(path, { force: true });
      db.prepare("VACUUM INTO ?").run(path);
      send(client, { type: "snapshotted", path });
    } catch (error) {
      send(client, { type: "error", message: error instanceof Error ? error.message : "Unable to snapshot terminal mux database" });
    }
    return;
  }
  if (message.type === "shutdown") { shutdown(client); return; }
  if (message.type === "attach") { attach(client, message); return; }
  if (message.type === "terminal_get") {
    const id = tabId(message.tabId);
    const terminal = id ? terminals.get(id) : null;
    const record = terminal?.record ?? (id ? row(id) : null);
    send(client, { type: "terminal", tabId: id, workspacePath: record?.cwd ?? null });
    return;
  }
  if (message.type === "detach") { detach(client); return; }
  if (message.type === "destroy") {
    const id = tabId(message.tabId);
    if (!id) return;
    const terminal = terminals.get(id);
    const requesterWasAttached = terminal?.clients.has(client) ?? false;
    if (terminal) {
      terminal.deleted = true;
      broadcast(terminal, { type: "destroyed", tabId: id });
      for (const attached of terminal.clients) attached.terminal = null;
      terminal.clients.clear();
      terminal.writer = null;
      try { terminal.pty.kill(); } catch { /* It may have exited between lookup and destroy. */ }
      terminals.delete(id);
    }
    db.prepare("DELETE FROM mux_terminal_tabs WHERE id = ?").run(id);
    if (!requesterWasAttached) send(client, { type: "destroyed", tabId: id });
    return;
  }
  const terminal = client.terminal;
  if (!terminal) return;
  if (message.type === "claim") {
    if (terminal.writer !== client) {
      terminal.writer = client;
      terminal.pty.resize(client.cols, client.rows);
      announceWriter(terminal);
    }
    return;
  }
  if (message.type === "configure") {
    const command = message.launchCommand === null ? null : valueString(message.launchCommand, 8_000);
    if (message.launchCommand !== null && command === null) { send(client, { type: "error", message: "Invalid launch command" }); return; }
    if (command !== null && !terminalLaunchCommand(command)) { send(client, { type: "error", message: "Invalid launch command" }); return; }
    if (!terminal.agentToken) terminal.record.launchCommand = command;
    flush(terminal);
    send(client, { type: "configured" });
    return;
  }
  if (message.type === "launch") {
    if (terminal.writer !== client) { send(client, { type: "denied", message: "Terminal is read-only because another pane has write access" }); return; }
    const command = valueString(message.launchCommand, 8_000);
    // Multiple browser tabs (or a double click before layout propagation) can
    // repeat the same intent. Confirm the already-running Agent without
    // writing a second interactive CLI into the same shell — but only when
    // the request actually matches what's running; a caller asking for a
    // different command was never applied and must not be told it succeeded.
    if (terminal.agentToken) {
      if (command === terminal.record.launchCommand) { send(client, { type: "launched" }); return; }
      send(client, { type: "error", message: "An Agent is already running with a different launch command" });
      return;
    }
    const token = randomUUID();
    const launch = command === null ? null : terminalLaunchCommand(command, process.platform, token);
    if (!launch) { send(client, { type: "error", message: "Invalid launch command" }); return; }
    // The user's explicit launch action is the point at which this becomes a
    // recovery command. Persist it before writing so an immediate server or
    // machine restart cannot lose that intent.
    const previousLaunchCommand = terminal.record.launchCommand;
    const previousAgentToken = terminal.agentToken;
    const previousCompletionTail = terminal.agentCompletionTail;
    terminal.record.launchCommand = command;
    terminal.agentToken = token;
    terminal.agentCompletionTail = "";
    flush(terminal);
    try {
      terminal.pty.write(`${launch}\r`);
      send(client, { type: "launched" });
    } catch (error) {
      terminal.record.launchCommand = previousLaunchCommand;
      terminal.agentToken = previousAgentToken;
      terminal.agentCompletionTail = previousCompletionTail;
      flush(terminal);
      send(client, { type: "error", message: error instanceof Error ? error.message : "Unable to launch Agent" });
    }
    return;
  }
  if (message.type === "resize") {
    client.cols = dimension(message.cols, client.cols, MAX_COLS);
    client.rows = dimension(message.rows, client.rows, MAX_ROWS);
    if (terminal.writer === client) terminal.pty.resize(client.cols, client.rows);
    return;
  }
  if (message.type === "interrupt") {
    if (terminal.writer === client) terminal.pty.write("\u0003");
    else send(client, { type: "denied", message: "Terminal is read-only because another pane has write access" });
    return;
  }
  if (message.type === "input") {
    if (terminal.writer !== client) { send(client, { type: "denied", message: "Terminal is read-only because another pane has write access" }); return; }
    if (typeof message.data !== "string") return;
    if (Buffer.byteLength(message.data, "utf8") > MAX_INPUT_BYTES) { send(client, { type: "error", message: "Terminal input is too large" }); return; }
    terminal.pty.write(message.data);
  }
}

function parse(line: string): Input | null {
  try {
    const value = JSON.parse(line) as { type?: unknown };
    if (typeof value.type !== "string") return null;
    return value as Input;
  } catch { return null; }
}

const allClients = new Set<Client>();

const server = createServer((socket) => {
  const client: Client = { id: randomUUID(), socket, buffer: "", terminal: null, cols: 100, rows: 30 };
  allClients.add(client);
  socket.setNoDelay(true);
  socket.on("data", (chunk: Buffer) => {
    client.buffer += chunk.toString("utf8");
    if (client.buffer.length > 256_000) { socket.destroy(); return; }
    let split: number;
    while ((split = client.buffer.indexOf("\n")) >= 0) {
      const line = client.buffer.slice(0, split); client.buffer = client.buffer.slice(split + 1);
      const message = parse(line); if (message) handle(client, message);
    }
  });
  socket.once("close", () => { detach(client); allClients.delete(client); });
  socket.once("error", () => { detach(client); allClients.delete(client); });
});
let listening = false;
let resolvingAddressConflict = false;

function listen(): void {
  server.listen(socketPath, () => {
    listening = true;
    resolvingAddressConflict = false;
    if (process.platform !== "win32") chmodSync(socketPath, 0o600);
    console.info(`[terminal-mux] listening on ${socketPath}`);
  });
}

function failStartup(error: Error): void {
  console.error("[terminal-mux] fatal:", error);
  try { db.close(); } catch { /* already closed */ }
  process.exit(1);
}

server.on("error", (error: NodeJS.ErrnoException) => {
  if (listening || resolvingAddressConflict || error.code !== "EADDRINUSE") { failStartup(error); return; }
  resolvingAddressConflict = true;
  // Binding is the ownership primitive. Never unlink an occupied Unix socket
  // merely because a protocol ping was slow: unlinking a live listener permits
  // two daemons (and two SQLite writers) to exist at once. Only ECONNREFUSED
  // proves that the filesystem entry is stale and has no listening owner.
  if (process.platform === "win32") { try { db.close(); } catch { /* already closed */ } process.exit(0); return; }
  const probe = createConnection(socketPath);
  let settled = false;
  const ownerExists = () => {
    if (settled) return;
    settled = true;
    probe.destroy();
    try { db.close(); } catch { /* already closed */ }
    process.exit(0);
  };
  probe.once("connect", ownerExists);
  probe.once("error", (probeError: NodeJS.ErrnoException) => {
    if (settled) return;
    settled = true;
    probe.destroy();
    if (probeError.code !== "ECONNREFUSED" && probeError.code !== "ENOENT") { failStartup(probeError); return; }
    rmSync(socketPath, { force: true });
    resolvingAddressConflict = false;
    listen();
  });
  setTimeout(ownerExists, 750).unref();
});

listen();

// A caller that awaits the "shutdown" RPC (e.g. a backup restore about to
// move this database file out from under us) must only see its reply after
// every daemon-owned resource is actually released — not before. So this
// closes the DB and removes the socket/pipe file FIRST, synchronously, and
// only then acknowledges the still-open requester socket, rather than the
// previous "ack now, clean up 10ms later" ordering that let a restore race
// ahead of the real shutdown.
function shutdown(replyTo: Client | null): void {
  // Retain persisted rows for recovery, but explicitly terminate every OS
  // process. deleted blocks late onExit callbacks after the DB is closed.
  for (const terminal of terminals.values()) {
    flush(terminal);
    terminal.deleted = true;
    terminal.writer = null;
    for (const client of terminal.clients) client.terminal = null;
    terminal.clients.clear();
    try { terminal.pty.kill(); } catch { /* already exited */ }
  }
  terminals.clear();
  server.close();
  // server.close()'s own callback only fires once every connected socket has
  // ended, so a still-attached browser bridge (or any other pending
  // connection) could otherwise block shutdown indefinitely; force it.
  for (const client of allClients) if (client !== replyTo) client.socket.destroy();
  db.close();
  if (process.platform !== "win32") rmSync(socketPath, { force: true });
  const finish = () => process.exit(0);
  if (replyTo && !replyTo.socket.destroyed) {
    replyTo.socket.end(`${JSON.stringify({ type: "shutting_down" })}\n`, finish);
    setTimeout(finish, 200).unref();
  } else finish();
}
process.once("SIGTERM", () => shutdown(null));
process.once("SIGINT", () => shutdown(null));
