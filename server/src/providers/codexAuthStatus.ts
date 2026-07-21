import type { AuthStatus } from "./types.js";

export function resolveCodexAuthStatus(
  error: NodeJS.ErrnoException | null,
): { status: AuthStatus; error: string | null } {
  if (!error) return { status: "authenticated", error: null };
  if (error.code === "ENOENT") return { status: "cli_missing", error: "找不到 Codex CLI" };
  return { status: "unauthenticated", error: null };
}
