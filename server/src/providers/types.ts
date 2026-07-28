export type ProviderId = "claude" | "codex";

export type AuthStatus =
  | "checking"
  | "authenticated"
  | "unauthenticated"
  | "cli_missing"
  | "error";

export type ProviderAuthState = {
  provider: ProviderId;
  displayName: string;
  status: AuthStatus;
  loginCommand: string;
  checkedAt: string | null;
  error: string | null;
  // Raw resolved-executable/exit-code/CLI-output snippet for the check that
  // produced this state. Populated only when status isn't "authenticated" —
  // for diagnosing machines where detection disagrees with reality.
  debug: string | null;
};

export interface AgentAuthProvider {
  readonly id: ProviderId;
  readonly displayName: string;
  readonly loginCommand: string;
  checkAuth(): Promise<ProviderAuthState>;
}
