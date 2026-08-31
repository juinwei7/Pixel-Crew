import { existsSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ensurePrivateDirectorySync, protectFileSync } from "./platform/fileProtection.js";

export type CodexHomeMigrationDeps = {
  existsSync: typeof existsSync;
  copyFileSync: typeof copyFileSync;
  ensureDir: (dir: string) => void;
  protect: (file: string) => void;
};

const defaultDeps: CodexHomeMigrationDeps = {
  existsSync,
  copyFileSync,
  ensureDir: ensurePrivateDirectorySync,
  protect: protectFileSync,
};

export type CodexHomeMigrationResult = { migrated: boolean; copiedConfig: boolean };

// One-time bootstrap for owners who already had `codex` logged in on their
// machine before Pixel Crew stopped reading the ambient $CODEX_HOME/~/.codex
// for its default (no-account-assigned) workers. Without this, upgrading
// would silently "log out" every existing install and drop their configured
// MCP servers. Runs once — decided purely by whether the managed directory
// already has an auth.json, not by any persisted flag — so a fresh install
// with nothing to migrate is indistinguishable from "already migrated".
// Never throws: a failed migration just means the owner logs in again inside
// the app, which is far better than refusing to start.
export function migrateAmbientCodexHome(
  defaultCodexHome: string,
  ambientCodexHome: string = process.env.CODEX_HOME?.trim() || join(homedir(), ".codex"),
  deps: CodexHomeMigrationDeps = defaultDeps,
): CodexHomeMigrationResult {
  try {
    if (deps.existsSync(join(defaultCodexHome, "auth.json"))) return { migrated: false, copiedConfig: false };
    const ambientAuth = join(ambientCodexHome, "auth.json");
    if (!deps.existsSync(ambientAuth)) return { migrated: false, copiedConfig: false };
    deps.ensureDir(defaultCodexHome);
    deps.copyFileSync(ambientAuth, join(defaultCodexHome, "auth.json"));
    deps.protect(join(defaultCodexHome, "auth.json"));
    const ambientConfig = join(ambientCodexHome, "config.toml");
    let copiedConfig = false;
    if (deps.existsSync(ambientConfig)) {
      deps.copyFileSync(ambientConfig, join(defaultCodexHome, "config.toml"));
      copiedConfig = true;
    }
    return { migrated: true, copiedConfig };
  } catch (error) {
    console.warn("[codex] failed to migrate ambient CODEX_HOME into Pixel Crew's managed default directory:", (error as Error).message);
    return { migrated: false, copiedConfig: false };
  }
}
