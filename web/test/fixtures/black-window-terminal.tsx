// Manual browser fixture: real React/xterm, simulated wire protocol. No PTY,
// account, workspace layout or user command is created or modified.
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { BlackWindowTerminal } from "../../src/components/BlackWindowTerminal";
import "../../src/index.css";

const messages: unknown[] = [];
const sockets: FixtureSocket[] = [];
function report() {
  const target = document.querySelector("#wire");
  if (target) target.textContent = JSON.stringify({ connections: sockets.length, messages }, null, 2);
}
class FixtureSocket {
  static OPEN = 1;
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  constructor() {
    sockets.push(this);
    setTimeout(() => { this.readyState = 1; this.onopen?.(); report(); }, 20);
  }
  send(raw: string) {
    const value = JSON.parse(raw);
    messages.push(value);
    if (value.type === "terminal_claim") this.receive({ type: "terminal_access", writable: true });
    report();
  }
  receive(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }); }
  close() { this.readyState = 3; this.onclose?.(); }
}
window.WebSocket = FixtureSocket as unknown as typeof WebSocket;
const latest = () => sockets[sockets.length - 1];

function Fixture() {
  const [hidden, setHidden] = useState(false);
  const [fontSize, setFontSize] = useState(13);
  return <main style={{ padding: 20, color: "white", background: "#111", minHeight: "100vh" }}>
    <nav style={{ display: "flex", gap: 12, marginBottom: 16 }}>
      <button onClick={() => latest().receive({ type: "terminal_ready", shell: "fixture-shell", writable: false, restored: true })}>Ready read-only</button>
      <button onClick={() => latest().close()}>Disconnect</button>
      <button onClick={() => latest().receive({ type: "terminal_exit", code: 0, signal: null })}>Shell exit</button>
      <button onClick={() => setHidden(!hidden)}>{hidden ? "Restore" : "Minimize"}</button>
      <button onClick={() => setFontSize(fontSize + 1)}>Larger font</button>
      <button onClick={() => { messages.length = 0; report(); }}>Clear wire log</button>
    </nav>
    <div className="black-workspace" style={{ position: "relative", display: hidden ? "none" : "grid", width: 720, height: 350 }}>
      <BlackWindowTerminal sessionId="isolated-fixture" workspacePath="/fixture" terminalLabel="Fixture" active fontSize={fontSize}/>
    </div>
    <pre id="wire" style={{ whiteSpace: "pre-wrap", marginTop: 16 }}/>
  </main>;
}
createRoot(document.getElementById("root")!).render(<Fixture/>);
