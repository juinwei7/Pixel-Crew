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
};

export interface AgentAuthProvider {
  readonly id: ProviderId;
  readonly displayName: string;
  readonly loginCommand: string;
  checkAuth(): Promise<ProviderAuthState>;
}
