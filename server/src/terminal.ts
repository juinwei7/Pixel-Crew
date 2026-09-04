import type { Socket } from "node:net";
import type { WebSocket } from "ws";
import { connectTerminalMux, ensureTerminalMuxDaemon, terminalMuxRequest } from "./terminalMuxClient.js";
import { terminalClientBufferWouldOverflow } from "./terminalFlowControl.js";

const MAX_INPUT_BYTES = 64_000;
const MAX_COLS = 500;
const MAX_ROWS = 300;
type TerminalInput =
  | { type: "terminal_open"; workspacePath: unknown; sessionId: unknown; cols: unknown; rows: unknown; launchCommand?: unknown }
  | { type: "terminal_input"; data: unknown }
  | { type: "terminal_resize"; cols: unknown; rows: unknown }
  | { type: "terminal_interrupt" }
  | { type: "terminal_configure"; launchCommand: unknown }
  | { type: "terminal_launch"; launchCommand: unknown }
  | { type: "terminal_destroy"; sessionId: unknown }
  | { type: "terminal_claim" }
  | { type: "terminal_close" };

type MuxInput =
  | { type: "ping"; requestId: string }
  | { type: "attach"; tabId: string; workspacePath: string; cols: number; rows: number; launchCommand?: string | null }
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number }
  | { type: "interrupt" }
  | { type: "configure"; launchCommand: string | null }
  | { type: "launch"; launchCommand: string }
  | { type: "claim" }
  | { type: "detach" }
  | { type: "destroy"; tabId: string };

function send(socket: WebSocket, payload: unknown): void {
  if (socket.readyState !== socket.OPEN) return;
  const frame = JSON.stringify(payload);
  if (terminalClientBufferWouldOverflow(socket.bufferedAmount, Buffer.byteLength(frame))) {
    socket.terminate();
    return;
  }
  try { socket.send(frame); } catch { socket.terminate(); }
}

function parseInput(raw: unknown): TerminalInput | null {
  if (typeof raw !== "string" || raw.length > MAX_INPUT_BYTES + 1_000) return null;
  try {
    const value = JSON.parse(raw) as { type?: unknown; workspacePath?: unknown; sessionId?: unknown; data?: unknown; cols?: unknown; rows?: unknown; launchCommand?: unknown };
    if (value.type === "terminal_open") return { type: value.type, workspacePath: value.workspacePath, sessionId: value.sessionId, cols: value.cols, rows: value.rows, launchCommand: value.launchCommand };
    if (value.type === "terminal_input") return { type: value.type, data: value.data };
    if (value.type === "terminal_resize") return { type: value.type, cols: value.cols, rows: value.rows };
    if (value.type === "terminal_interrupt") return { type: value.type };
    if (value.type === "terminal_configure" || value.type === "terminal_launch") return { type: value.type, launchCommand: value.launchCommand };
    if (value.type === "terminal_destroy") return { type: value.type, sessionId: value.sessionId };
    if (value.type === "terminal_claim") return { type: value.type };
    if (value.type === "terminal_close") return { type: value.type };
  } catch { /* Ignore malformed messages on the shared websocket. */ }
  return null;
}

function dimension(value: unknown, fallback: number, maximum: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= maximum ? value : fallback;
}

export function isTerminalTabId(value: unknown): value is string {
  return typeof value === "string" && /^terminal-[a-zA-Z0-9-]{8,120}$/.test(value);
}

function muxSend(socket: Socket, message: MuxInput): void {
  if (!socket.destroyed && socket.writable) {
    try { socket.write(`${JSON.stringify(message)}\n`); } catch { socket.destroy(); }
  }
}

/** Browser bridge to Pixel Crew's independent PTY/mux owner. */
export function attachTerminalSocket(socket: WebSocket, normalizeWorkspacePath: (value: unknown, terminalTabId: string) => string | Promise<string>): () => void {
  let mux: Socket | null = null;
  let muxBuffer = "";
  let opening = false;
  let openingTabId: string | null = null;
  const cancelledOpenTabs = new Set<string>();
  let stopped = false;
  const stop = () => {
    stopped = true;
    if (mux && !mux.destroyed) muxSend(mux, { type: "detach" });
    mux?.destroy(); mux = null;
  };
  const open = async (input: Extract<TerminalInput, { type: "terminal_open" }>) => {
    if (opening) return;
    opening = true;
    openingTabId = input.sessionId as string;
    if (mux && !mux.destroyed) { muxSend(mux, { type: "detach" }); mux.destroy(); mux = null; }
    if (!isTerminalTabId(input.sessionId)) { send(socket, { type: "terminal_error", message: "Invalid terminal tab" }); opening = false; openingTabId = null; return; }
    let workspacePath: string;
    try { workspacePath = await normalizeWorkspacePath(input.workspacePath, input.sessionId as string); }
    catch (error) { send(socket, { type: "terminal_error", message: error instanceof Error ? error.message : "Invalid workspace" }); opening = false; openingTabId = null; return; }
    const cols = dimension(input.cols, 100, MAX_COLS);
    const rows = dimension(input.rows, 30, MAX_ROWS);
    try {
      await ensureTerminalMuxDaemon();
    } catch (error) {
      send(socket, { type: "terminal_error", message: error instanceof Error ? error.message : "Unable to start terminal mux" }); opening = false; openingTabId = null; return;
    }
    if (stopped || cancelledOpenTabs.has(input.sessionId as string)) { opening = false; openingTabId = null; return; }
    const connection = connectTerminalMux(); mux = connection;
    let settled = false;
    const finishOpening = () => {
      if (settled) return;
      settled = true;
      clearTimeout(attachTimeout);
      if (openingTabId === input.sessionId) { opening = false; openingTabId = null; }
    };
    const attachTimeout = setTimeout(() => {
      if (settled) return;
      finishOpening();
      if (mux === connection) mux = null;
      connection.destroy();
      send(socket, { type: "terminal_error", message: "Terminal mux attach timed out" });
    }, 3_000);
    connection.on("connect", () => {
      if (cancelledOpenTabs.has(input.sessionId as string)) { finishOpening(); connection.destroy(); return; }
      muxSend(connection, { type: "attach", tabId: input.sessionId as string, workspacePath, cols, rows, launchCommand: input.launchCommand === null || typeof input.launchCommand === "string" ? input.launchCommand : undefined });
    });
    connection.on("data", (chunk: Buffer) => {
      muxBuffer += chunk.toString("utf8");
      if (terminalClientBufferWouldOverflow(0, Buffer.byteLength(muxBuffer))) {
        finishOpening();
        connection.destroy();
        send(socket, { type: "terminal_error", message: "Terminal mux output exceeded the client buffer limit" });
        return;
      }
      let newline: number;
      while ((newline = muxBuffer.indexOf("\n")) >= 0) {
        const line = muxBuffer.slice(0, newline); muxBuffer = muxBuffer.slice(newline + 1);
        try {
          const message = JSON.parse(line) as { type?: string; data?: unknown; message?: unknown; workspacePath?: unknown; shell?: unknown; persistent?: unknown; restored?: unknown; writable?: unknown; code?: unknown; signal?: unknown; tabId?: unknown };
          if (message.type === "output" && typeof message.data === "string") send(socket, { type: "terminal_output", data: message.data });
          else if (message.type === "ready") { finishOpening(); send(socket, { type: "terminal_ready", workspacePath: message.workspacePath, shell: message.shell, persistent: message.persistent, restored: message.restored, writable: message.writable === true }); }
          else if (message.type === "access") send(socket, { type: "terminal_access", writable: message.writable === true });
          else if (message.type === "launched") send(socket, { type: "terminal_launched" });
          // A "denied" write attempt while read-only is not a connection failure —
          // keep it out of terminal_error so the pane doesn't flip to an error state.
          else if (message.type === "denied") send(socket, { type: "terminal_denied" });
          else if (message.type === "error") { finishOpening(); send(socket, { type: "terminal_error", message: message.message }); }
          else if (message.type === "exit") { finishOpening(); send(socket, { type: "terminal_exit", code: message.code ?? null, signal: message.signal ?? null }); }
          else if (message.type === "destroyed") { finishOpening(); if (mux === connection) mux = null; connection.destroy(); send(socket, { type: "terminal_exit", code: null, signal: null, destroyed: true }); }
        } catch { /* Ignore invalid daemon framing; the connection remains isolated. */ }
      }
    });
    connection.once("error", (error) => { finishOpening(); if (mux === connection) mux = null; send(socket, { type: "terminal_error", message: error.message || "Terminal mux connection failed" }); });
    connection.once("close", () => { finishOpening(); if (!stopped && mux === connection) { mux = null; send(socket, { type: "terminal_error", message: "Terminal mux disconnected; reconnect the pane to attach again" }); } });
  };

  socket.on("message", (buffer) => {
    const input = parseInput(buffer.toString());
    if (!input) return;
    if (input.type === "terminal_open") { cancelledOpenTabs.delete(input.sessionId as string); void open(input); return; }
    if (input.type === "terminal_close") { stop(); return; }
    if (input.type === "terminal_destroy") {
      if (!isTerminalTabId(input.sessionId)) return;
      cancelledOpenTabs.add(input.sessionId);
      if (openingTabId === input.sessionId) openingTabId = null;
      // This one-shot RPC is deliberately independent of the persistent
      // attach. It covers cold-start and connect races where `mux` exists but
      // has not yet attached a terminal.
      void terminalMuxRequest({ type: "destroy", tabId: input.sessionId }).catch((error: unknown) => {
        send(socket, { type: "terminal_error", message: error instanceof Error ? error.message : "Unable to destroy terminal" });
      });
      return;
    }
    if (input.type === "terminal_interrupt") { if (mux) muxSend(mux, { type: "interrupt" }); return; }
    if (input.type === "terminal_claim") { if (mux) muxSend(mux, { type: "claim" }); return; }
    if (input.type === "terminal_configure") {
      if (mux && (input.launchCommand === null || typeof input.launchCommand === "string")) muxSend(mux, { type: "configure", launchCommand: input.launchCommand });
      return;
    }
    if (input.type === "terminal_launch") {
      if (mux && typeof input.launchCommand === "string") muxSend(mux, { type: "launch", launchCommand: input.launchCommand });
      return;
    }
    if (input.type === "terminal_resize") {
      if (mux) muxSend(mux, { type: "resize", cols: dimension(input.cols, 100, MAX_COLS), rows: dimension(input.rows, 30, MAX_ROWS) });
      return;
    }
    if (!mux || typeof input.data !== "string") return;
    if (Buffer.byteLength(input.data, "utf8") > MAX_INPUT_BYTES) { send(socket, { type: "terminal_error", message: "Terminal input is too large" }); return; }
    muxSend(mux, { type: "input", data: input.data });
  });
  socket.once("close", stop);
  socket.once("error", stop);
  return stop;
}
