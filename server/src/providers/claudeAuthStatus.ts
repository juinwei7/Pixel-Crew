import type { AuthStatus } from "./types.js";

export function resolveClaudeAuthStatus(
  error: NodeJS.ErrnoException | null,
  stdout: string,
): { status: AuthStatus; error: string | null } {
  if (error?.code === "ENOENT") {
    return { status: "cli_missing", error: "找不到 Claude Code CLI" };
  }

  try {
    const parsed = JSON.parse(stdout) as { loggedIn?: boolean };
    if (parsed.loggedIn === true) return { status: "authenticated", error: null };
    if (parsed.loggedIn === false) return { status: "unauthenticated", error: null };
  } catch {
    // Fall through to a diagnostic state when the CLI does not return JSON.
  }

  return {
    status: "error",
    error: error?.message || "無法確認 Claude 登入狀態",
  };
}
