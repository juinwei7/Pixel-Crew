import { existsSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ensurePrivateDirectorySync, protectFileSync } from "./platform/fileProtection.js";

export type ClaudeHomeMigrationDeps = {
  existsSync: typeof existsSync;
  copyFileSync: typeof copyFileSync;
  ensureDir: (dir: string) => void;
  protect: (file: string) => void;
};

const defaultDeps: ClaudeHomeMigrationDeps = {
  existsSync,
  copyFileSync,
  ensureDir: ensurePrivateDirectorySync,
  protect: protectFileSync,
};

export type ClaudeHomeMigrationResult = { migrated: boolean };

// Mirrors codexHomeMigration.ts. One-time bootstrap for owners who already
// had `claude` logged in on their machine before Pixel Crew stopped reading
// ambient ~/.claude.json for its default (no-account-assigned) workers.
// `.claude.json` is the single file CLAUDE_CONFIG_DIR relocates (OAuth
// session, MCP config, project trust list) — unlike Codex there's no sibling
// config file to carry over. Runs once, decided purely by whether the
// managed directory already has a .claude.json. Never throws.
export function migrateAmbientClaudeHome(
  defaultClaudeHome: string,
  ambientHome: string = homedir(),
  deps: ClaudeHomeMigrationDeps = defaultDeps,
): ClaudeHomeMigrationResult {
  try {
    if (deps.existsSync(join(defaultClaudeHome, ".claude.json"))) return { migrated: false };
    const ambientClaudeJson = join(ambientHome, ".claude.json");
    if (!deps.existsSync(ambientClaudeJson)) return { migrated: false };
    deps.ensureDir(defaultClaudeHome);
    deps.copyFileSync(ambientClaudeJson, join(defaultClaudeHome, ".claude.json"));
    deps.protect(join(defaultClaudeHome, ".claude.json"));
    return { migrated: true };
  } catch (error) {
    console.warn("[claude] failed to migrate ambient ~/.claude.json into Pixel Crew's managed default directory:", (error as Error).message);
    return { migrated: false };
  }
}
