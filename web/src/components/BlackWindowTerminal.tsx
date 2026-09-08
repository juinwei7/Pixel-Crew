import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { t } from "../i18n";
import { runtimeWsOrigin } from "../runtimeOrigin";
import { terminalVoiceInput } from "../blackWindowWorkspace";

type TerminalMessage =
  | { type: "terminal_ready"; workspacePath: string; shell: string; persistent?: boolean; restored?: boolean; writable?: boolean; agentRunning?: boolean }
  | { type: "terminal_output"; data: string }
  | { type: "terminal_error"; message: string; recoverable?: boolean }
  | { type: "terminal_exit"; code: number | null; signal: number | null; destroyed?: boolean }
  | { type: "terminal_access"; writable: boolean }
  | { type: "terminal_launched" }
  | { type: "terminal_agent_exit"; code: number | null }
  | { type: "terminal_denied" };

const browserOrigin = typeof window !== "undefined" ? window.location.origin : "http://localhost:8787";
const terminalWsUrl = `${runtimeWsOrigin(browserOrigin).replace(/\/$/, "")}/ws`;

function sendTerminal(socket: WebSocket | null, message: unknown): void {
  if (socket?.readyState !== WebSocket.OPEN) return;
  try { socket.send(JSON.stringify(message)); } catch { /* A close can race the readyState check. */ }
}

export type BlackWindowTerminalHandle = { inject(command: string): void; insertText(text: string): void; launch(command: string): Promise<boolean>; interrupt(): void; destroy(): Promise<boolean> };

type Props = { sessionId: string; workspacePath: string; terminalLabel: string; active: boolean; fontSize: number; launchCommand?: string | null; onActivate?(): void; onStatus?(status: "connecting" | "ready" | "closed" | "error"): void; onReady?(state: { restored: boolean; agentRunning?: boolean }): void; onExit?(): void };

/**
 * A real xterm.js terminal backed by an OS pseudo-terminal. Nothing is
 * interpreted by Pixel Crew: all keystrokes, ANSI control sequences, cursor
 * positioning, full-screen programs and interactive CLIs flow between the
 * browser terminal and the local PTY.
 */
export const BlackWindowTerminal = forwardRef<BlackWindowTerminalHandle, Props>(function BlackWindowTerminal({ sessionId, workspacePath, terminalLabel, active, fontSize, launchCommand, onActivate, onStatus, onReady, onExit }, ref) {
  const hostRef = useRef<HTMLDivElement>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const pendingLaunchRef = useRef<((ok: boolean) => void) | null>(null);
  const onReadyRef = useRef(onReady);
  const onExitRef = useRef(onExit);
  const activeRef = useRef(active);
  const launchCommandRef = useRef(launchCommand);
  const reconnectAttemptRef = useRef(0);
  const [connectionEpoch, setConnectionEpoch] = useState(0);
  const [status, setStatus] = useState<"connecting" | "ready" | "closed" | "error">("connecting");
  const [shell, setShell] = useState("");
  const [writable, setWritable] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  // `undefined` means no completion has been observed, while `null` means the
  // daemon knows the Agent ended but could not recover a trustworthy code.
  // Keep this pane-local so the reason remains visible after layout sync has
  // already changed agentStarted back to false.
  const [agentExitCode, setAgentExitCode] = useState<number | null | undefined>(undefined);

  useEffect(() => { onStatus?.(status); }, [onStatus, status]);
  useEffect(() => { onReadyRef.current = onReady; }, [onReady]);
  useEffect(() => { onExitRef.current = onExit; }, [onExit]);
  useEffect(() => { activeRef.current = active; }, [active]);
  launchCommandRef.current = launchCommand;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    let terminalEnded = false;
    let reconnectTimer: number | undefined;
    setStatus("connecting");
    setShell("");
    setWritable(false);
    const terminal = new Terminal({
      cursorBlink: true,
      cursorStyle: "bar",
      // xterm measures its own character cells and cannot resolve CSS custom
      // properties here. A concrete font stack keeps glyph and cell widths in
      // sync when fontSize changes.
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, 'Cascadia Mono', Consolas, 'Courier New', monospace",
      disableStdin: true,
      fontSize,
      fontWeight: "500",
      lineHeight: 1.25,
      scrollback: 10_000,
      theme: { background: "#050606", foreground: "#d6f8cf", cursor: "#86ed89", selectionBackground: "#285441", black: "#050606", brightBlack: "#65726c", green: "#86ed89", brightGreen: "#bfffd4" },
    });
    const fit = new FitAddon();
    fitRef.current = fit;
    terminal.loadAddon(fit);
    terminal.open(host);
    // A read-only pane cannot use shell completion. Let Tab reach the control
    // claim button (or leave the pane) instead of trapping keyboard users.
    terminal.attachCustomKeyEventHandler((event) => !(terminal.options.disableStdin && event.key === "Tab"));
    if (activeRef.current) terminal.focus();
    terminalRef.current = terminal;

    const socket = new WebSocket(terminalWsUrl);
    socketRef.current = socket;
    const resize = () => {
      // Hidden/minimized panes have no usable geometry. Preserve the last PTY
      // size until ResizeObserver sees the pane become visible again.
      if (!host.clientWidth || !host.clientHeight) return;
      fit.fit();
      sendTerminal(socket, { type: "terminal_resize", cols: terminal.cols, rows: terminal.rows });
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    const scheduleReconnect = () => {
      if (disposed || terminalEnded || reconnectTimer !== undefined) return;
      setReconnecting(true);
      setWritable(false);
      terminal.options.disableStdin = true;
      const delay = Math.min(8_000, 800 * 2 ** reconnectAttemptRef.current++);
      reconnectTimer = window.setTimeout(() => setConnectionEpoch((current) => current + 1), delay);
    };
    const input = terminal.onData((data) => {
      if (!terminal.options.disableStdin) sendTerminal(socket, { type: "terminal_input", data });
    });
    socket.onopen = () => {
      // Layout sync can change the recovery command while this socket is still
      // connecting. Read the current prop here instead of the effect closure,
      // otherwise an old null can erase the daemon's persisted Agent command.
      sendTerminal(socket, { type: "terminal_open", sessionId, workspacePath, cols: terminal.cols, rows: terminal.rows, launchCommand: launchCommandRef.current });
      resize();
    };
    socket.onmessage = (event) => {
      let message: TerminalMessage | null = null;
      try { message = JSON.parse(String(event.data)) as TerminalMessage; } catch { return; }
      if (message.type === "terminal_ready") {
        reconnectAttemptRef.current = 0;
        setReconnecting(false);
        setShell(message.shell);
        setStatus("ready");
        setWritable(message.writable === true);
        terminal.options.disableStdin = message.writable !== true;
        if (activeRef.current) terminal.focus();
        if (message.agentRunning === true) setAgentExitCode(undefined);
        else if (message.agentRunning === false && launchCommandRef.current) {
          // The Agent may have completed while this browser was disconnected.
          // Its exact code is unavailable, but the daemon can still tell us
          // that the persistent shell survived and is ready for another run.
          setAgentExitCode((current) => current === undefined ? null : current);
        }
        onReadyRef.current?.({ restored: message.restored === true, agentRunning: message.agentRunning });
      } else if (message.type === "terminal_output") terminal.write(message.data);
      else if (message.type === "terminal_error") { pendingLaunchRef.current?.(false); pendingLaunchRef.current = null; setStatus("error"); setReconnecting(false); setWritable(false); terminal.options.disableStdin = true; terminal.writeln(`\r\n[Pixel Crew terminal error: ${message.message}]`); if (message.recoverable) scheduleReconnect(); }
      else if (message.type === "terminal_access") { setWritable(message.writable); terminal.options.disableStdin = !message.writable; }
      else if (message.type === "terminal_launched") { setAgentExitCode(undefined); pendingLaunchRef.current?.(true); pendingLaunchRef.current = null; }
      else if (message.type === "terminal_agent_exit") { setAgentExitCode(message.code); onExitRef.current?.(); }
      else if (message.type === "terminal_denied") { pendingLaunchRef.current?.(false); pendingLaunchRef.current = null; setWritable(false); terminal.options.disableStdin = true; }
      else if (message.type === "terminal_exit") { terminalEnded = true; setReconnecting(false); if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer); setWritable(false); terminal.options.disableStdin = true; setStatus("closed"); terminal.writeln(message.destroyed ? "\r\n[terminal destroyed]" : `\r\n[shell exited · ${message.signal || message.code || 0}]`); if (!message.destroyed) onExitRef.current?.(); }
    };
    socket.onerror = () => setStatus("error");
    socket.onclose = () => {
      pendingLaunchRef.current?.(false); pendingLaunchRef.current = null;
      if (disposed || terminalEnded) return;
      setStatus((current) => current === "error" ? current : "closed");
      scheduleReconnect();
    };
    return () => {
      disposed = true;
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      observer.disconnect();
      input.dispose();
      pendingLaunchRef.current?.(false);
      pendingLaunchRef.current = null;
      sendTerminal(socket, { type: "terminal_close" });
      socket.close();
      terminal.dispose();
      if (socketRef.current === socket) socketRef.current = null;
      if (terminalRef.current === terminal) terminalRef.current = null;
      if (fitRef.current === fit) fitRef.current = null;
    };
  }, [connectionEpoch, sessionId, workspacePath]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    terminal.options.fontSize = fontSize;
    // xterm re-measures its character cell asynchronously after a font-size
    // option change. Fitting immediately reuses the previous cell width, so
    // larger glyphs overlap even though their pixel size is correct. Give the
    // renderer one frame to measure and fit on the following frame.
    let fitFrame = 0;
    const measureFrame = window.requestAnimationFrame(() => {
      fitFrame = window.requestAnimationFrame(() => {
        if (!hostRef.current?.clientWidth || !hostRef.current.clientHeight) return;
        fitRef.current?.fit();
        terminal.refresh(0, Math.max(0, terminal.rows - 1));
        sendTerminal(socketRef.current, { type: "terminal_resize", cols: terminal.cols, rows: terminal.rows });
      });
    });
    return () => {
      window.cancelAnimationFrame(measureFrame);
      if (fitFrame) window.cancelAnimationFrame(fitFrame);
    };
  }, [fontSize]);

  useEffect(() => {
    // A configure effect that ran while CONNECTING was previously dropped by
    // sendTerminal. Re-run after terminal_ready so the durable recovery hint
    // always converges to the latest layout without launching the Agent twice.
    if (launchCommand === undefined || status !== "ready") return;
    const socket = socketRef.current;
    sendTerminal(socket, { type: "terminal_configure", launchCommand });
  }, [launchCommand, status]);

  useEffect(() => { if (active) terminalRef.current?.focus(); }, [active]);

  useImperativeHandle(ref, () => ({
    inject(command) {
      const socket = socketRef.current;
      sendTerminal(socket, { type: "terminal_input", data: `${command.replace(/\r?\n$/, "")}\r` });
    },
    insertText(text) {
      const data = terminalVoiceInput(text);
      const socket = socketRef.current;
      if (!data || status !== "ready" || socket?.readyState !== WebSocket.OPEN) return;
      // Keep voice input consistent with clicking the terminal: claim a
      // persistent read-only pane first, then type without submitting it.
      if (!writable) sendTerminal(socket, { type: "terminal_claim" });
      sendTerminal(socket, { type: "terminal_input", data });
      terminalRef.current?.focus();
    },
    launch(command) {
      if (status !== "ready" || socketRef.current?.readyState !== WebSocket.OPEN || pendingLaunchRef.current) return Promise.resolve(false);
      setAgentExitCode(undefined);
      return new Promise<boolean>((resolve) => {
        const timer = window.setTimeout(() => {
          if (!pendingLaunchRef.current) return;
          pendingLaunchRef.current = null;
          resolve(false);
        }, 3_000);
        pendingLaunchRef.current = (ok) => { window.clearTimeout(timer); resolve(ok); };
        // Clicking Launch is an explicit request to control this persistent
        // pane. Claim and launch are ordered on the same WebSocket, so a tab
        // that was read-only can start the Agent without requiring a separate
        // click inside the terminal first.
        if (!writable) sendTerminal(socketRef.current, { type: "terminal_claim" });
        sendTerminal(socketRef.current, { type: "terminal_launch", launchCommand: command });
      });
    },
    interrupt() {
      if (status !== "ready" || socketRef.current?.readyState !== WebSocket.OPEN) return;
      // Interrupt is an explicit control action, just like Launch. A second
      // browser may currently be the writer, so claim first; WebSocket message
      // ordering guarantees the daemon transfers control before Ctrl+C arrives.
      if (!writable) sendTerminal(socketRef.current, { type: "terminal_claim" });
      sendTerminal(socketRef.current, { type: "terminal_interrupt" });
    },
    async destroy() {
      // Use exactly one authoritative request. A former best-effort WS send
      // raced this REST call, so the daemon could delete the PTY through WS
      // while a transient REST failure made the UI claim it was still alive.
      // REST reaches the daemon even while this pane's socket is reconnecting.
      try {
        const response = await fetch(`/api/terminal-mux/tabs/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
        return response.ok;
      } catch {
        return false;
      }
    },
  }), [sessionId, status, writable]);

  const agentResult = agentExitCode === undefined
    ? terminalLabel
    : agentExitCode === 0
      ? t("Agent 已正常結束；shell 可繼續使用")
      : agentExitCode === null
        ? t("Agent 已結束；shell 可繼續使用")
        : t("Agent 已結束（退出碼 {code}）；shell 可繼續使用", { code: agentExitCode });

  return <section className="black-window-terminal" aria-label={t("黑窗 CLI 終端")} onPointerDown={(event) => { event.stopPropagation(); onActivate?.(); }} onClick={() => {
    if (status === "ready" && !writable) sendTerminal(socketRef.current, { type: "terminal_claim" });
    terminalRef.current?.focus();
  }}>
    <div ref={hostRef} className="black-window-terminal__screen" />
    <footer>
      <span role="status" aria-live="polite">{agentResult} · {status === "ready" ? `${shell || t("已連線")}${writable ? "" : ` · ${t("唯讀")}`}` : reconnecting ? t("連線中斷，正在重新連線…") : status === "connecting" ? t("正在建立終端連線…") : status === "closed" ? t("終端已結束") : t("連線失敗")}</span>
      {status === "ready" && !writable && <button type="button" onClick={(event) => {
        event.stopPropagation();
        sendTerminal(socketRef.current, { type: "terminal_claim" });
        terminalRef.current?.focus();
      }}>{t("取得終端控制權")}</button>}
    </footer>
  </section>;
});
