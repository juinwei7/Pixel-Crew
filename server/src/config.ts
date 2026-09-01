import "dotenv/config";
import { dirname, join } from "node:path";
import { realpathSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { appDataDirectory, defaultWorkspaceDirectory, migrateLegacyData } from "./platform/paths.js";
import { ensurePrivateDirectorySync } from "./platform/fileProtection.js";

const dataDirectory = process.env.PIXEL_CREW_DATA_DIR?.trim() || appDataDirectory();
const legacyDbPath = fileURLToPath(new URL("../data/cockpit.sqlite", import.meta.url));
const dbPath =
  process.env.DB_PATH?.trim() ||
  join(dataDirectory, "cockpit.sqlite");
const avatarDir = process.env.AVATAR_DIR?.trim() || join(dirname(dbPath), "avatars");
// Extracted so this security-critical check is directly unit-testable —
// config.ts itself runs its checks as a side effect of being imported, which
// can't be exercised per-case in a normal test without spawning a subprocess.
export function isLoopbackHost(host: string): boolean {
  return ["127.0.0.1", "localhost", "::1"].includes(host);
}

const configuredHost = process.env.HOST?.trim() || "127.0.0.1";
if (!isLoopbackHost(configuredHost)) {
  throw new Error("Pixel Crew has no remote authentication; HOST must remain a loopback address");
}
const configuredTarget = process.env.TARGET_REPO_PATH?.trim();
const generatedTarget = defaultWorkspaceDirectory();
let targetRepoPath = "";
let targetRepoConfigured = false;
if (configuredTarget) {
  try {
    const canonical = realpathSync(configuredTarget);
    if (!statSync(canonical).isDirectory()) throw new Error("not a directory");
    targetRepoPath = canonical;
    targetRepoConfigured = true;
  } catch {
    console.warn(`TARGET_REPO_PATH is not an accessible directory; using the dedicated Pixel Crew workspace instead: ${configuredTarget}`);
  }
}
if (!targetRepoConfigured) {
  ensurePrivateDirectorySync(generatedTarget);
  targetRepoPath = realpathSync(generatedTarget);
}

try {
  migrateLegacyData(legacyDbPath, dbPath, avatarDir);
} catch (error) {
  console.warn("Unable to migrate legacy Pixel Crew data; continuing with the configured data path:", (error as Error).message);
}

export const config = {
  // Never expose the user's home directory itself as an agent workspace.
  // First launch asks the user to accept this dedicated directory or choose
  // another project before any worker is created.
  targetRepoPath,
  targetRepoConfigured,
  permissionMode: process.env.PERMISSION_MODE ?? "acceptEdits",
  claudeBin: process.env.CLAUDE_BIN ?? "claude",
  codexBin: process.env.CODEX_BIN ?? "codex",
  codexSandbox: process.env.CODEX_SANDBOX ?? "workspace-write",
  port: Number(process.env.PORT ?? 8787),
  host: configuredHost,
  dbPath,
  avatarDir,
  dataDirectory: dirname(dbPath),
  // Pixel Crew's own managed Codex login for workers with no explicit
  // codexAccountId — deliberately NOT the ambient $CODEX_HOME/~/.codex the
  // host's own `codex` CLI uses, so the app never depends on (or silently
  // shares state with) whatever the user is logged into in their terminal.
  defaultCodexHome: join(dirname(dbPath), "codex-home"),
  // Same idea as defaultCodexHome, for Claude — points CLAUDE_CONFIG_DIR away
  // from ambient ~/.claude.json so Pixel Crew's own login never depends on
  // (or overwrites) whatever the terminal's own `claude auth login` has.
  defaultClaudeHome: join(dirname(dbPath), "claude-home"),
  // whisper-server 常駐子行程；模型只在啟動時載入一次，見 voiceEngineServer.ts。
  whisperServerBin: process.env.WHISPER_SERVER_BIN?.trim() || "whisper-server",
  voiceServerPort: Number(process.env.VOICE_SERVER_PORT ?? 8793),
  voiceModelsDir: join(dirname(dbPath), "voice-models"),
  voiceEnginesDir: join(dirname(dbPath), "voice-engines"),
  webDistPath: process.env.WEB_DIST_PATH?.trim() || fileURLToPath(new URL("../../web/dist", import.meta.url)),
  production: process.env.NODE_ENV === "production" || process.argv.includes("--serve-web"),
};
