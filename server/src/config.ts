import "dotenv/config";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

const dbPath =
  process.env.DB_PATH?.trim() ||
  fileURLToPath(new URL("../data/cockpit.sqlite", import.meta.url));

export const config = {
  targetRepoPath: required("TARGET_REPO_PATH"),
  permissionMode: process.env.PERMISSION_MODE ?? "acceptEdits",
  claudeBin: process.env.CLAUDE_BIN ?? "claude",
  codexBin: process.env.CODEX_BIN ?? "codex",
  codexSandbox: process.env.CODEX_SANDBOX ?? "workspace-write",
  port: Number(process.env.PORT ?? 8787),
  host: process.env.HOST?.trim() || "127.0.0.1",
  dbPath,
  avatarDir: process.env.AVATAR_DIR?.trim() || join(dirname(dbPath), "avatars"),
};
