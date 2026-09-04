import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createConnection, type Socket } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { isTerminalTabId } from "../src/terminal.js";
import { terminalMuxPipeName } from "../src/terminalMuxPipeName.js";
import { commandInvocation } from "../src/platform/processes.js";
import { parseTerminalLaunchCommand, terminalLaunchCommand } from "../src/terminalLaunch.js";
import { MAX_TERMINAL_CLIENT_BUFFER_BYTES, terminalClientBufferWouldOverflow } from "../src/terminalFlowControl.js";

test("stable black-window ids are accepted by the private mux", () => {
  assert.equal(isTerminalTabId("terminal-123e4567-e89b-12d3-a456-426614174000"), true);
});

test("terminal tab ids reject shell injection", () => {
  assert.equal(isTerminalTabId("terminal-a; kill-server"), false);
  assert.equal(isTerminalTabId("not-a-terminal"), false);
  assert.equal(isTerminalTabId("terminal-short"), false);
});

test("terminal launch commands round-trip quoted values without becoming shell syntax", () => {
  const source = "CODEX_HOME='C:\\Users\\A B%TEMP%' codex --no-alt-screen --model 'model\" & calc & rem'";
  assert.deepEqual(parseTerminalLaunchCommand(source), {
    environment: { name: "CODEX_HOME", value: "C:\\Users\\A B%TEMP%" },
    executable: "codex",
    args: ["--no-alt-screen", "--model", "model\" & calc & rem"],
  });
  const windows = terminalLaunchCommand(source, "win32");
  assert.match(windows ?? "", /^powershell\.exe .* -EncodedCommand [A-Za-z0-9+/=]+$/);
  assert.doesNotMatch(windows ?? "", /A B|TEMP|calc|model/);
  const posix = terminalLaunchCommand(source, "darwin");
  assert.equal(posix, "CODEX_HOME='C:\\Users\\A B%TEMP%' 'codex' '--no-alt-screen' '--model' 'model\" & calc & rem'");
});

test("terminal launch commands reject arbitrary restored shell text and mismatched account homes", () => {
  assert.equal(terminalLaunchCommand("curl example.test | sh", "win32"), null);
  assert.equal(terminalLaunchCommand("CLAUDE_CONFIG_DIR='/tmp/x' codex", "win32"), null);
  assert.equal(terminalLaunchCommand("codex\ncalc.exe", "win32"), null);
});

test("terminal client buffers have a hard upper bound", () => {
  assert.equal(terminalClientBufferWouldOverflow(0, MAX_TERMINAL_CLIENT_BUFFER_BYTES), false);
  assert.equal(terminalClientBufferWouldOverflow(MAX_TERMINAL_CLIENT_BUFFER_BYTES, 1), true);
  assert.equal(terminalClientBufferWouldOverflow(MAX_TERMINAL_CLIENT_BUFFER_BYTES - 20, 21), true);
});

test("Windows pipe names hash the full path instead of truncating it, so near-identical data dirs cannot collide", () => {
  const a = terminalMuxPipeName("C:\\Users\\alice\\AppData\\Local\\Pixel Crew");
  const b = terminalMuxPipeName("C:\\Users\\alice\\AppData\\Local\\Pixel Crew Dev");
  assert.notEqual(a, b);
  assert.match(a, /^\\\\\.\\pipe\\pixel-crew-mux-[0-9a-f]{32}$/);
  // Same input must always hash to the same pipe so a second launch of the
  // same install finds the existing daemon instead of spawning a duplicate.
  assert.equal(terminalMuxPipeName("C:\\Users\\alice\\AppData\\Local\\Pixel Crew"), a);
  assert.equal(terminalMuxPipeName("c:\\users\\ALICE\\appdata\\local\\pixel crew"), a);
});

test("Windows pipe names resolve directory junction aliases", { skip: process.platform !== "win32" }, () => {
  const root = mkdtempSync(join(tmpdir(), "pixel-crew-pipe-"));
  const target = join(root, "real-data");
  const alias = join(root, "data-junction");
  try {
    mkdirSync(target);
    symlinkSync(target, alias, "junction");
    assert.equal(terminalMuxPipeName(alias), terminalMuxPipeName(target));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Spawns the real TypeScript daemon through Node's tsx loader. Production's
// .cmd-shim invocation is covered separately by commandInvocation tests.
// against an isolated data dir so lifecycle/protocol behavior — not just the
// tabId regex — actually gets exercised: startup, attach, the atomic
// VACUUM INTO snapshot RPC, and that "shutdown" only acks once the daemon
// has genuinely released its socket and database file.
function startDaemon(dataDirectory: string): ChildProcess {
  const serverDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const entry = join(serverDir, "src", "terminalMuxDaemon.ts");
  const invocation = commandInvocation(process.execPath, ["--import", "tsx", entry]);
  return spawn(invocation.file, invocation.args, {
    stdio: ["ignore", "ignore", "pipe"],
    env: { ...process.env, PIXEL_CREW_DATA_DIR: dataDirectory },
  });
}

function connect(socketPath: string, attempts = 50): Promise<Socket> {
  return new Promise((resolvePromise, reject) => {
    const tryOnce = (remaining: number) => {
      const socket = createConnection(socketPath);
      socket.once("connect", () => resolvePromise(socket));
      socket.once("error", () => {
        socket.destroy();
        if (remaining <= 0) { reject(new Error("could not connect to terminal mux daemon")); return; }
        setTimeout(() => tryOnce(remaining - 1), 100);
      });
    };
    tryOnce(attempts);
  });
}

function rpcClient(socket: Socket) {
  let buffer = "";
  const pending: Array<Record<string, unknown>> = [];
  const waiters: Array<(value: Record<string, unknown>) => void> = [];
  socket.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line) as Record<string, unknown>;
      const waiter = waiters.shift();
      if (waiter) waiter(message); else pending.push(message);
    }
  });
  return {
    send(message: Record<string, unknown>): void { socket.write(`${JSON.stringify(message)}\n`); },
    next(timeoutMs = 5_000): Promise<Record<string, unknown>> {
      const queued = pending.shift();
      if (queued) return Promise.resolve(queued);
      return new Promise((resolvePromise, reject) => {
        const timer = setTimeout(() => reject(new Error("terminal mux daemon did not reply in time")), timeoutMs);
        waiters.push((value) => { clearTimeout(timer); resolvePromise(value); });
      });
    },
    async waitFor(predicate: (message: Record<string, unknown>) => boolean, timeoutMs = 5_000): Promise<Record<string, unknown>> {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const message = await this.next(Math.max(1, deadline - Date.now()));
        if (predicate(message)) return message;
      }
    },
  };
}

function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function childExit(child: ChildProcess, timeoutMs = 5_000): Promise<number | null> {
  return new Promise((resolvePromise, reject) => {
    if (child.exitCode !== null) { resolvePromise(child.exitCode); return; }
    const timer = setTimeout(() => reject(new Error("child process did not exit in time")), timeoutMs);
    child.once("exit", (code) => { clearTimeout(timer); resolvePromise(code); });
  });
}

async function waitForProcessExit(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (!processExists(pid)) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  assert.fail(`PTY process ${pid} survived controlled mux shutdown`);
}

test("mux daemon lifecycle: attach spawns a real PTY, snapshot is atomic, shutdown only acks once fully stopped", { timeout: 20_000 }, async () => {
  // macOS exposes /tmp as /private/tmp; the explicit real path also works in
  // restricted runners that disallow binding sockets below the per-user temp alias.
  const socketTempRoot = process.platform === "darwin" ? "/private/tmp" : tmpdir();
  const dataDirectory = mkdtempSync(join(socketTempRoot, "pixel-crew-mux-daemon-"));
  const socketPath = process.platform === "win32" ? terminalMuxPipeName(dataDirectory) : join(dataDirectory, "terminal-mux.sock");
  const child = startDaemon(dataDirectory);
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  try {
    const socket = await connect(socketPath);
    const client = rpcClient(socket);

    client.send({ type: "ping", requestId: "1" });
    const pong = await client.next();
    assert.equal(pong.type, "pong");
    assert.equal(pong.requestId, "1");

    // A concurrent launcher must yield to the listener that already owns the
    // socket. In particular it must not unlink that live socket and create a
    // second daemon against the same SQLite database.
    const contender = startDaemon(dataDirectory);
    assert.equal(await childExit(contender), 0);
    client.send({ type: "ping", requestId: "still-owner" });
    const ownerPong = await client.next();
    assert.equal(ownerPong.type, "pong");
    assert.equal(ownerPong.requestId, "still-owner");
    assert.equal(ownerPong.protocolVersion, 2);

    const emptySnapshotPath = join(dataDirectory, "empty-snapshot.sqlite");
    client.send({ type: "snapshot", path: emptySnapshotPath });
    const emptySnapshot = await client.waitFor((message) => message.type === "not_initialized" || message.type === "error");
    assert.equal(emptySnapshot.type, "not_initialized");
    assert.equal(existsSync(emptySnapshotPath), false);

    const tabId = `terminal-${randomUUID()}`;
    client.send({ type: "attach", tabId, workspacePath: dataDirectory, cols: 80, rows: 24 });
    const ready = await client.waitFor((message) => message.type === "ready" || message.type === "error");
    assert.equal(ready.type, "ready", `attach failed: ${JSON.stringify(ready)}`);
    assert.equal(ready.restored, false);
    assert.equal(typeof ready.pid, "number");
    const ptyPid = ready.pid as number;
    assert.equal(processExists(ptyPid), true);

    // Switching an Agent pane back to Raw Shell must clear the durable launch
    // hint. Otherwise a later daemon restart would unexpectedly launch the old
    // agent even though the UI says this pane is raw.
    client.send({ type: "configure", launchCommand: "codex --no-alt-screen" });
    assert.equal((await client.waitFor((message) => message.type === "configured" || message.type === "error")).type, "configured");
    client.send({ type: "configure", launchCommand: null });
    assert.equal((await client.waitFor((message) => message.type === "configured" || message.type === "error")).type, "configured");

    const snapshotPath = join(dataDirectory, "snapshot.sqlite");
    client.send({ type: "snapshot", path: snapshotPath });
    const snapshotted = await client.waitFor((message) => message.type === "snapshotted" || message.type === "error");
    assert.equal(snapshotted.type, "snapshotted", `snapshot failed: ${JSON.stringify(snapshotted)}`);
    assert.ok(existsSync(snapshotPath), "snapshot file must exist after a successful snapshot ack");

    // The snapshot must be independently openable and contain the attached
    // terminal's row — this is exactly what a backup export ships.
    const snapshotDb = new DatabaseSync(snapshotPath, { readOnly: true });
    try {
      const row = snapshotDb.prepare("SELECT id FROM mux_terminal_tabs WHERE id = ?").get(tabId) as { id?: string } | undefined;
      assert.equal(row?.id, tabId);
      const configured = snapshotDb.prepare("SELECT launch_command FROM mux_terminal_tabs WHERE id = ?").get(tabId) as { launch_command?: string | null } | undefined;
      assert.equal(configured?.launch_command, null);
    } finally {
      snapshotDb.close();
    }

    // An explicit launch both writes to the PTY and arms recovery. Merely
    // selecting Agent mode in the UI no longer does this before the click.
    client.send({ type: "launch", launchCommand: "codex --version" });
    assert.equal((await client.waitFor((message) => message.type === "launched" || message.type === "error")).type, "launched");
    client.send({ type: "checkpoint" });
    assert.equal((await client.waitFor((message) => message.type === "checkpointed" || message.type === "error")).type, "checkpointed");
    const liveDb = new DatabaseSync(join(dataDirectory, "terminal-mux.sqlite"), { readOnly: true });
    try {
      const launched = liveDb.prepare("SELECT launch_command FROM mux_terminal_tabs WHERE id = ?").get(tabId) as { launch_command?: string | null } | undefined;
      assert.equal(launched?.launch_command, "codex --version");
    } finally {
      liveDb.close();
    }

    // A relative/non-absolute path must be rejected rather than silently
    // resolved against the daemon's own cwd.
    client.send({ type: "snapshot", path: "relative.sqlite" });
    const rejected = await client.waitFor((message) => message.type === "error" || message.type === "snapshotted");
    assert.equal(rejected.type, "error");

    const exited = new Promise<number | null>((resolvePromise) => child.once("exit", (code) => resolvePromise(code)));
    client.send({ type: "shutdown" });
    const shuttingDown = await client.waitFor((message) => message.type === "shutting_down");
    assert.equal(shuttingDown.type, "shutting_down");
    // By the time the ack is observed, the daemon must have already
    // released its socket/pipe and database file — not "soon after".
    assert.equal(existsSync(socketPath), process.platform === "win32");
    await exited;
    await waitForProcessExit(ptyPid);
    socket.destroy();

    // A fresh connection attempt must fail fast now that the daemon is gone
    // (rather than hang, which is what an un-drained server.close() risked).
    await assert.rejects(() => connect(socketPath, 3));
  } finally {
    if (!child.killed) child.kill();
    rmSync(dataDirectory, { recursive: true, force: true });
    if (stderr) console.error("[terminal mux daemon stderr]", stderr);
  }
});
