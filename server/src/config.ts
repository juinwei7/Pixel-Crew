import "dotenv/config";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { realpathSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { appDataDirectory, migrateLegacyData } from "./platform/paths.js";

const dataDirectory = process.env.PIXEL_CREW_DATA_DIR?.trim() || appDataDirectory();
const legacyDbPath = fileURLToPath(new URL("../data/cockpit.sqlite", import.meta.url));
const dbPath =
  process.env.DB_PATH?.trim() ||
  join(dataDirectory, "cockpit.sqlite");
const avatarDir = process.env.AVATAR_DIR?.trim() || join(dirname(dbPath), "avatars");
const configuredHost = process.env.HOST?.trim() || "127.0.0.1";
if (!["127.0.0.1", "localhost", "::1"].includes(configuredHost)) {
  throw new Error("Pixel Crew has no remote authentication; HOST must remain a loopback address");
}
const configuredTarget = process.env.TARGET_REPO_PATH?.trim();
let targetRepoPath = homedir();
if (configuredTarget) {
  try {
    const canonical = realpathSync(configuredTarget);
    if (!statSync(canonical).isDirectory()) throw new Error("not a directory");
    targetRepoPath = canonical;
  } catch {
    console.warn(`TARGET_REPO_PATH is not an accessible directory; starting in the user home instead: ${configuredTarget}`);
  }
}

try {
  migrateLegacyData(legacyDbPath, dbPath, avatarDir);
} catch (error) {
  console.warn("Unable to migrate legacy Pixel Crew data; continuing with the configured data path:", (error as Error).message);
}

export const config = {
  // A first launch no longer crashes without .env. The user's home is a safe,
  // existing room until they choose their actual project in the UI.
  targetRepoPath,
  permissionMode: process.env.PERMISSION_MODE ?? "acceptEdits",
  claudeBin: process.env.CLAUDE_BIN ?? "claude",
  codexBin: process.env.CODEX_BIN ?? "codex",
  codexSandbox: process.env.CODEX_SANDBOX ?? "workspace-write",
  port: Number(process.env.PORT ?? 8787),
  host: configuredHost,
  dbPath,
  avatarDir,
  dataDirectory: dirname(dbPath),
  webDistPath: process.env.WEB_DIST_PATH?.trim() || fileURLToPath(new URL("../../web/dist", import.meta.url)),
  production: process.env.NODE_ENV === "production" || process.argv.includes("--serve-web"),
};
