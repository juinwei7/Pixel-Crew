// Only connects to the disposable audit bridge, never the app's live daemon.
import React from "react";
import { createRoot } from "react-dom/client";
import { BlackWindowTerminal } from "../../src/components/BlackWindowTerminal";
import "../../src/index.css";

const NativeSocket = window.WebSocket;
const params = new URLSearchParams(window.location.search);
const port = params.get("port");
const token = params.get("token");
if (!/^\d{1,5}$/.test(port ?? "") || !token) throw new Error("Start the disposable PTY server and open the URL it prints.");
let connections = 0;
const frames: unknown[] = [];
function report() {
  const output = document.querySelector("#wire");
  if (output) output.textContent = JSON.stringify({ connections, frames }, null, 2);
}
class AuditSocket extends NativeSocket {
  constructor() {
    super(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`);
    connections += 1;
    this.addEventListener("message", (event) => {
      const frame = JSON.parse(String(event.data));
      if (frame.type !== "terminal_output") frames.push(frame);
      report();
    });
    this.addEventListener("open", report);
  }
  send(raw: string) {
    frames.push(JSON.parse(raw));
    report();
    super.send(raw);
  }
}
window.WebSocket = AuditSocket;
createRoot(document.getElementById("root")!).render(<main style={{ padding: 16, background: "#111", color: "white", minHeight: "100vh" }}>
  <p>Disposable PTY audit — type exit to end only this test shell.</p>
  <div className="black-workspace" style={{ position: "relative", height: 350 }}>
    <BlackWindowTerminal sessionId="terminal-disposable-ui-audit" workspacePath="/fixture" terminalLabel="Disposable PTY" active fontSize={13}/>
  </div>
  <pre id="wire" style={{ whiteSpace: "pre-wrap" }}/>
</main>);
