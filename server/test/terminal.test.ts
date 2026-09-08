import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createConnection, type Socket } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { isTerminalTabId } from "../src/terminal.js";
import { terminalMuxPipeName } from "../src/terminalMuxPipeName.js";
import { TERMINAL_MUX_PROTOCOL_VERSION } from "../src/terminalMuxProtocol.js";
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
  const completionToken = "123e4567-e89b-12d3-a456-426614174000";
  const trackedPosix = terminalLaunchCommand(source, "darwin", completionToken);
  assert.match(trackedPosix ?? "", /^\/bin\/sh -c /);
  assert.match(trackedPosix ?? "", /pixel-crew-agent-exit;123e4567-e89b-12d3-a456-426614174000/);
  const trackedWindows = terminalLaunchCommand(source, "win32", completionToken);
  const encoded = trackedWindows?.split(" ").at(-1) ?? "";
  const windowsScript = Buffer.from(encoded, "base64").toString("utf16le");
  assert.match(windowsScript, /pixel-crew-agent-exit;123e4567-e89b-12d3-a456-426614174000/);
  assert.equal(terminalLaunchCommand(source, "darwin", "bad;token"), null);
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
function startDaemon(dataDirectory: string, executablePath = process.env.PATH): ChildProcess {
  const serverDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const entry = join(serverDir, "src", "terminalMuxDaemon.ts");
  const invocation = commandInvocation(process.execPath, ["--import", "tsx", entry]);
  return spawn(invocation.file, invocation.args, {
    stdio: ["ignore", "ignore", "pipe"],
    env: { ...process.env, PATH: executablePath, PIXEL_CREW_DATA_DIR: dataDirectory },
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
  const recent: Array<Record<string, unknown>> = [];
  socket.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line) as Record<string, unknown>;
      recent.push(message);
      if (recent.length > 8) recent.shift();
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
        const timer = setTimeout(() => {
          const received = JSON.stringify(recent).slice(-2_000);
          reject(new Error(`terminal mux daemon did not reply in time; recent messages: ${received}`));
        }, timeoutMs);
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

function removeMuxTestDirectory(directory: string): void {
  try {
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Hosted Windows runners can retain the exited ConPTY cwd handle after
    // both the shell PID and daemon are gone. The runner reclaims its temp
    // root; keep every other platform and error strict.
    if (process.platform !== "win32" || (code !== "EBUSY" && code !== "EPERM")) throw error;
  }
}

const terminalSizeProbe = process.platform === "win32"
  ? `powershell.exe -NoLogo -NoProfile -Command "Write-Output ('__SIZE__' + [Console]::WindowHeight + 'x' + [Console]::WindowWidth)"\r`
  : `stty size | awk '{print "__SIZE__"$1"x"$2}'\r`;

test("mux daemon lifecycle: attach spawns a real PTY, snapshot is atomic, shutdown only acks once fully stopped", { timeout: 20_000 }, async () => {
  // macOS exposes /tmp as /private/tmp; the explicit real path also works in
  // restricted runners that disallow binding sockets below the per-user temp alias.
  const socketTempRoot = process.platform === "darwin" ? "/private/tmp" : tmpdir();
  const dataDirectory = mkdtempSync(join(socketTempRoot, "pixel-crew-mux-daemon-"));
  // The lifecycle test launches an Agent command but must not depend on Codex
  // being installed on a developer machine or hosted CI runner.
  const testBin = join(dataDirectory, "test-bin");
  mkdirSync(testBin);
  if (process.platform === "win32") writeFileSync(join(testBin, "codex.cmd"), "@echo off\r\nexit /b 0\r\n");
  else writeFileSync(join(testBin, "codex"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const testPath = `${testBin}${delimiter}${process.env.PATH ?? ""}`;
  const socketPath = process.platform === "win32" ? terminalMuxPipeName(dataDirectory) : join(dataDirectory, "terminal-mux.sock");
  const child = startDaemon(dataDirectory, testPath);
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
    const contender = startDaemon(dataDirectory, testPath);
    assert.equal(await childExit(contender), 0);
    client.send({ type: "ping", requestId: "still-owner" });
    const ownerPong = await client.next();
    assert.equal(ownerPong.type, "pong");
    assert.equal(ownerPong.requestId, "still-owner");
    assert.equal(ownerPong.protocolVersion, TERMINAL_MUX_PROTOCOL_VERSION);

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
    assert.equal(ready.agentRunning, false);
    assert.equal(typeof ready.pid, "number");
    const ptyPid = ready.pid as number;
    assert.equal(processExists(ptyPid), true);

    // A second browser can observe the same persistent terminal, but its
    // viewport must not reflow the current writer's interactive program.
    const spectatorSocket = await connect(socketPath);
    const spectator = rpcClient(spectatorSocket);
    spectator.send({ type: "attach", tabId, workspacePath: dataDirectory, cols: 120, rows: 40 });
    const spectatorReady = await spectator.waitFor((message) => message.type === "ready" || message.type === "error");
    assert.equal(spectatorReady.type, "ready");
    assert.equal(spectatorReady.writable, false);
    client.send({ type: "input", data: terminalSizeProbe });
    const writerSize = await client.waitFor((message) => message.type === "output" && String(message.data).includes("__SIZE__24x80"));
    assert.match(String(writerSize.data), /__SIZE__24x80/);

    spectator.send({ type: "resize", cols: 140, rows: 50 });
    client.send({ type: "input", data: terminalSizeProbe });
    const unchangedSize = await client.waitFor((message) => message.type === "output" && String(message.data).includes("__SIZE__24x80"));
    assert.match(String(unchangedSize.data), /__SIZE__24x80/);

    spectator.send({ type: "claim" });
    const claimed = await spectator.waitFor((message) => message.type === "access" && message.writable === true);
    assert.equal(claimed.writable, true);
    spectator.send({ type: "input", data: terminalSizeProbe });
    const claimedSize = await spectator.waitFor((message) => message.type === "output" && String(message.data).includes("__SIZE__50x140"));
    assert.match(String(claimedSize.data), /__SIZE__50x140/);

    // If the writer disappears while a viewer remains, a later attach must
    // not silently seize control. The remaining viewer (or the newcomer) has
    // to claim explicitly, preserving the mux's user-action ownership rule.
    spectatorSocket.destroy();
    assert.equal((await client.waitFor((message) => message.type === "access" && message.writable === false)).writable, false);
    const newcomerSocket = await connect(socketPath);
    const newcomer = rpcClient(newcomerSocket);
    newcomer.send({ type: "attach", tabId, workspacePath: dataDirectory, cols: 100, rows: 32 });
    const newcomerReady = await newcomer.waitFor((message) => message.type === "ready" || message.type === "error");
    assert.equal(newcomerReady.type, "ready");
    assert.equal(newcomerReady.writable, false);

    // Return control to the original browser before exercising the rest of
    // the lifecycle so later launch/configure assertions keep their intent.
    client.send({ type: "claim" });
    assert.equal((await client.waitFor((message) => message.type === "access" && message.writable === true)).writable, true);
    newcomerSocket.destroy();

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

    // An explicit launch writes to the PTY and arms recovery while it runs.
    // Once the child command returns to the persistent shell, the daemon must
    // emit a distinct Agent exit and disarm recovery without killing the PTY.
    client.send({ type: "launch", launchCommand: "codex --version" });
    assert.equal((await client.waitFor((message) => message.type === "launched" || message.type === "error")).type, "launched");
    const agentExit = await client.waitFor((message) => message.type === "agent_exit" || message.type === "error");
    assert.equal(agentExit.type, "agent_exit");
    assert.equal(agentExit.code, 0);
    // A stale browser may still believe the Agent is running until it receives
    // this event. Reattaching that old layout must not re-arm or relaunch the
    // completed command; daemon lifecycle state is authoritative.
    const staleSocket = await connect(socketPath);
    const stale = rpcClient(staleSocket);
    stale.send({ type: "attach", tabId, workspacePath: dataDirectory, cols: 90, rows: 28, launchCommand: "codex --version" });
    const staleReady = await stale.waitFor((message) => message.type === "ready" || message.type === "error");
    assert.equal(staleReady.type, "ready");
    assert.equal(staleReady.agentRunning, false);
    staleSocket.destroy();
    client.send({ type: "checkpoint" });
    assert.equal((await client.waitFor((message) => message.type === "checkpointed" || message.type === "error")).type, "checkpointed");
    const liveDb = new DatabaseSync(join(dataDirectory, "terminal-mux.sqlite"), { readOnly: true });
    try {
      const launched = liveDb.prepare("SELECT launch_command FROM mux_terminal_tabs WHERE id = ?").get(tabId) as { launch_command?: string | null } | undefined;
      assert.equal(launched?.launch_command, null);
    } finally {
      liveDb.close();
    }

    // A relative/non-absolute path must be rejected rather than silently
    // resolved against the daemon's own cwd.
    client.send({ type: "snapshot", path: "relative.sqlite" });
    const rejected = await client.waitFor((message) => message.type === "error" || message.type === "snapshotted");
    assert.equal(rejected.type, "error");

    // A normal shell exit must detach every viewer from the dead PTY. Browser
    // ResizeObservers can still emit after the exit frame; that late resize
    // must be ignored instead of throwing inside (and killing) the daemon.
    client.send({ type: "input", data: "exit\r" });
    assert.equal((await client.waitFor((message) => message.type === "exit")).type, "exit");
    client.send({ type: "resize", cols: 90, rows: 28 });
    client.send({ type: "ping", requestId: "after-shell-exit" });
    const afterExitPong = await client.waitFor((message) => message.type === "pong" && message.requestId === "after-shell-exit");
    assert.equal(afterExitPong.requestId, "after-shell-exit");

    const exited = new Promise<number | null>((resolvePromise) => child.once("exit", (code) => resolvePromise(code)));
    client.send({ type: "shutdown" });
    const shuttingDown = await client.waitFor((message) => message.type === "shutting_down");
    assert.equal(shuttingDown.type, "shutting_down");
    // By the time the ack is observed, the daemon must have already
    // released its database file — not "soon after". Windows named-pipe
    // teardown is asynchronous relative to the ack write, so existsSync on
    // the pipe path is racy there; the later rejected reconnect is what
    // actually proves the pipe is gone on every platform.
    if (process.platform !== "win32") assert.equal(existsSync(socketPath), false);
    await exited;
    await waitForProcessExit(ptyPid);
    socket.destroy();
    spectatorSocket.destroy();

    // A fresh connection attempt must fail fast now that the daemon is gone
    // (rather than hang, which is what an un-drained server.close() risked).
    await assert.rejects(() => connect(socketPath, 3));
  } finally {
    if (!child.killed) child.kill();
    removeMuxTestDirectory(dataDirectory);
    if (stderr) console.error("[terminal mux daemon stderr]", stderr);
  }
});
