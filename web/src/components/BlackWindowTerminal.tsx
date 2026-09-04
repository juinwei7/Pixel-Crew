import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { t } from "../i18n";
import { runtimeWsOrigin } from "../runtimeOrigin";

type TerminalMessage =
  | { type: "terminal_ready"; workspacePath: string; shell: string; persistent?: boolean; restored?: boolean; writable?: boolean }
  | { type: "terminal_output"; data: string }
  | { type: "terminal_error"; message: string }
  | { type: "terminal_exit"; code: number | null; signal: number | null; destroyed?: boolean }
  | { type: "terminal_access"; writable: boolean }
  | { type: "terminal_launched" }
  | { type: "terminal_denied" };

const browserOrigin = typeof window !== "undefined" ? window.location.origin : "http://localhost:8787";
const terminalWsUrl = `${runtimeWsOrigin(browserOrigin).replace(/\/$/, "")}/ws`;

function sendTerminal(socket: WebSocket | null, message: unknown): void {
  if (socket?.readyState !== WebSocket.OPEN) return;
  try { socket.send(JSON.stringify(message)); } catch { /* A close can race the readyState check. */ }
}

export type BlackWindowTerminalHandle = { inject(command: string): void; launch(command: string): Promise<boolean>; interrupt(): void; destroy(): Promise<boolean> };

type Props = { sessionId: string; workspacePath: string; terminalLabel: string; active: boolean; launchCommand?: string | null; onActivate?(): void; onStatus?(status: "connecting" | "ready" | "closed" | "error"): void; onReady?(state: { restored: boolean }): void };

/**
 * A real xterm.js terminal backed by an OS pseudo-terminal. Nothing is
 * interpreted by Pixel Crew: all keystrokes, ANSI control sequences, cursor
 * positioning, full-screen programs and interactive CLIs flow between the
 * browser terminal and the local PTY.
 */
export const BlackWindowTerminal = forwardRef<BlackWindowTerminalHandle, Props>(function BlackWindowTerminal({ sessionId, workspacePath, terminalLabel, active, launchCommand = null, onActivate, onStatus, onReady }, ref) {
  const hostRef = useRef<HTMLDivElement>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const pendingLaunchRef = useRef<((ok: boolean) => void) | null>(null);
  const onReadyRef = useRef(onReady);
  const [status, setStatus] = useState<"connecting" | "ready" | "closed" | "error">("connecting");
  const [shell, setShell] = useState("");
  const [writable, setWritable] = useState(false);

  useEffect(() => { onStatus?.(status); }, [onStatus, status]);
  useEffect(() => { onReadyRef.current = onReady; }, [onReady]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    setStatus("connecting");
    setShell("");
    setWritable(false);
    const terminal = new Terminal({
      cursorBlink: true,
      cursorStyle: "bar",
      fontFamily: "var(--mono), Menlo, Monaco, 'Courier New', monospace",
      fontSize: 13,
      fontWeight: "500",
      lineHeight: 1.25,
      scrollback: 10_000,
      theme: { background: "#050606", foreground: "#d6f8cf", cursor: "#86ed89", selectionBackground: "#285441", black: "#050606", brightBlack: "#65726c", green: "#86ed89", brightGreen: "#bfffd4" },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host);
    terminal.focus();
    terminalRef.current = terminal;

    const socket = new WebSocket(terminalWsUrl);
    socketRef.current = socket;
    const resize = () => {
      fit.fit();
      sendTerminal(socket, { type: "terminal_resize", cols: terminal.cols, rows: terminal.rows });
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    const input = terminal.onData((data) => {
      if (!terminal.options.disableStdin) sendTerminal(socket, { type: "terminal_input", data });
    });
    socket.onopen = () => {
      sendTerminal(socket, { type: "terminal_open", sessionId, workspacePath, cols: terminal.cols, rows: terminal.rows, launchCommand });
      resize();
    };
    socket.onmessage = (event) => {
      let message: TerminalMessage | null = null;
      try { message = JSON.parse(String(event.data)) as TerminalMessage; } catch { return; }
      if (message.type === "terminal_ready") {
        setShell(message.shell);
        setStatus("ready");
        setWritable(message.writable === true);
        terminal.options.disableStdin = message.writable !== true;
        terminal.focus();
        onReadyRef.current?.({ restored: message.restored === true });
      } else if (message.type === "terminal_output") terminal.write(message.data);
      else if (message.type === "terminal_error") { pendingLaunchRef.current?.(false); pendingLaunchRef.current = null; setStatus("error"); terminal.writeln(`\r\n[Pixel Crew terminal error: ${message.message}]`); }
      else if (message.type === "terminal_access") { setWritable(message.writable); terminal.options.disableStdin = !message.writable; }
      else if (message.type === "terminal_launched") { pendingLaunchRef.current?.(true); pendingLaunchRef.current = null; }
      else if (message.type === "terminal_denied") { pendingLaunchRef.current?.(false); pendingLaunchRef.current = null; setWritable(false); terminal.options.disableStdin = true; }
      else if (message.type === "terminal_exit") { setWritable(false); terminal.options.disableStdin = true; setStatus("closed"); terminal.writeln(message.destroyed ? "\r\n[terminal destroyed]" : `\r\n[shell exited · ${message.signal || message.code || 0}]`); }
    };
    socket.onerror = () => setStatus("error");
    socket.onclose = () => { pendingLaunchRef.current?.(false); pendingLaunchRef.current = null; setStatus((current) => current === "error" ? current : "closed"); };
    return () => {
      observer.disconnect();
      input.dispose();
      pendingLaunchRef.current?.(false);
      pendingLaunchRef.current = null;
      sendTerminal(socket, { type: "terminal_close" });
      socket.close();
      terminal.dispose();
      if (socketRef.current === socket) socketRef.current = null;
      if (terminalRef.current === terminal) terminalRef.current = null;
    };
  }, [sessionId, workspacePath]);

  useEffect(() => {
    const socket = socketRef.current;
    sendTerminal(socket, { type: "terminal_configure", launchCommand });
  }, [launchCommand]);

  useEffect(() => { if (active) terminalRef.current?.focus(); }, [active]);

  useImperativeHandle(ref, () => ({
    inject(command) {
      const socket = socketRef.current;
      sendTerminal(socket, { type: "terminal_input", data: `${command.replace(/\r?\n$/, "")}\r` });
    },
    launch(command) {
      if (!writable || socketRef.current?.readyState !== WebSocket.OPEN || pendingLaunchRef.current) return Promise.resolve(false);
      return new Promise<boolean>((resolve) => {
        const timer = window.setTimeout(() => {
          if (!pendingLaunchRef.current) return;
          pendingLaunchRef.current = null;
          resolve(false);
        }, 3_000);
        pendingLaunchRef.current = (ok) => { window.clearTimeout(timer); resolve(ok); };
        sendTerminal(socketRef.current, { type: "terminal_launch", launchCommand: command });
      });
    },
    interrupt() {
      sendTerminal(socketRef.current, { type: "terminal_interrupt" });
    },
    async destroy() {
      // The WS bridge can be mid-reconnect (or never opened) when the pane
      // is closed, in which case terminal_destroy is silently dropped and
      // the daemon-owned PTY would leak with no way back to it from the UI.
      // The REST endpoint reaches the daemon directly regardless of this
      // pane's socket state, so it — not the WS message — is authoritative.
      sendTerminal(socketRef.current, { type: "terminal_destroy", sessionId });
      try {
        const response = await fetch(`/api/terminal-mux/tabs/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
        return response.ok;
      } catch {
        return false;
      }
    },
  }), [sessionId, writable]);

  return <section className="black-window-terminal" aria-label={t("黑窗 CLI 終端")} onPointerDown={(event) => { event.stopPropagation(); onActivate?.(); }} onClick={() => {
    if (status === "ready" && !writable) sendTerminal(socketRef.current, { type: "terminal_claim" });
    terminalRef.current?.focus();
  }}>
    <div ref={hostRef} className="black-window-terminal__screen" />
    <footer>{terminalLabel} · {status === "ready" ? `${shell || t("已連線")}${writable ? "" : ` · ${t("唯讀；點擊取得控制權")}`}` : status === "connecting" ? t("正在建立 PTY…") : status === "closed" ? t("已結束") : t("連線失敗")}</footer>
  </section>;
});
