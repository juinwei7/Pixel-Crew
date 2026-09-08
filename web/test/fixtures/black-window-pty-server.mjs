// Run from repository root: node --import tsx web/test/fixtures/black-window-pty-server.mjs
// Then open /test/fixtures/black-window-pty.html in the existing Vite preview.
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";

const directory = mkdtempSync(join(process.platform === "darwin" ? "/private/tmp" : tmpdir(), "pixel-crew-ui-pty-"));
// Define every data path before importing config. Precreate the empty DB so
// legacy migration cannot copy any user database into this fixture.
process.env.PIXEL_CREW_DATA_DIR = directory;
process.env.PIXEL_CREW_MUX_DATA_DIR = directory;
process.env.DB_PATH = join(directory, "cockpit.sqlite");
process.env.AVATAR_DIR = join(directory, "avatars");
process.env.TARGET_REPO_PATH = directory;
writeFileSync(process.env.DB_PATH, "", { mode: 0o600 });
const { attachTerminalSocket } = await import("../../../server/src/terminal.ts");
const { terminalMuxRequest } = await import("../../../server/src/terminalMuxClient.ts");
const token = randomUUID();
let terminalOpened = false;
const server = new WebSocketServer({
  host: "127.0.0.1", port: 0, path: "/ws",
  verifyClient: ({ origin, req }) => {
    const allowedOrigin = origin === "http://localhost:5173" || origin === "http://127.0.0.1:5173";
    const suppliedToken = new URL(req.url ?? "", "http://127.0.0.1").searchParams.get("token");
    return allowedOrigin && suppliedToken === token;
  },
});
server.on("connection", (socket) => {
  socket.on("message", (buffer) => {
    try { if (JSON.parse(buffer.toString()).type === "terminal_open") terminalOpened = true; } catch { /* Production bridge validates the frame. */ }
  });
  attachTerminalSocket(socket, (path, id) => {
    if (path !== "/fixture" || id !== "terminal-disposable-ui-audit") throw new Error("Not an audit terminal");
    return directory;
  });
});
server.on("listening", () => {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Disposable PTY bridge has no TCP address");
  console.log(`Open http://localhost:5173/test/fixtures/black-window-pty.html?port=${address.port}&token=${token}`);
  console.log(`Disposable data: ${directory}`);
});
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  clearTimeout(expiry);
  for (const socket of server.clients) socket.terminate();
  await new Promise((resolve) => server.close(resolve));
  try {
    if (!terminalOpened) {
      rmSync(directory, { recursive: true, force: true });
      console.log("Unused disposable PTY data removed.");
      return;
    }
    const result = await terminalMuxRequest({ type: "shutdown" });
    if (result.type !== "shutting_down") throw new Error("No shutdown acknowledgement");
    rmSync(directory, { recursive: true, force: true });
    console.log("Disposable mux shut down; audit data removed.");
  } catch (error) {
    console.error(`Preserving audit data at ${directory}: ${error.message}`);
    process.exitCode = 1;
  }
}
const expiry = setTimeout(() => void stop(), 10 * 60_000);
server.once("error", (error) => {
  clearTimeout(expiry);
  // A bind failure occurs before this bridge can spawn any terminal daemon.
  rmSync(directory, { recursive: true, force: true });
  console.error(error.message);
  process.exitCode = 1;
});
process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
