import type { AgentAuthProvider, ProviderAuthState, ProviderId } from "./providers/types.js";
import type { ProviderAccount } from "./store.js";

function initialState(provider: AgentAuthProvider): ProviderAuthState {
  return {
    provider: provider.id,
    displayName: provider.displayName,
    status: "checking",
    loginCommand: provider.loginCommand,
    checkedAt: null,
    error: null,
    debug: null,
  };
}

// One AgentAuthProvider instance per named account (Codex or Claude), so each
// account's own caching/last-checked status lives in its own instance and
// never cross-contaminates another account's. Provider-agnostic: the caller
// supplies both the accountId -> ProviderAccount lookup and the (provider,
// homeDir) -> AgentAuthProvider factory, so this one registry serves Codex
// and Claude accounts alike instead of two near-duplicate registries.
export class AccountRegistry {
  private readonly providers = new Map<string, AgentAuthProvider>();
  private readonly states = new Map<string, ProviderAuthState>();

  constructor(
    private readonly getAccount: (accountId: string) => ProviderAccount | null,
    private readonly authProviderFor: (provider: ProviderId, homeDir: string) => AgentAuthProvider,
  ) {}

  private ensureProvider(accountId: string): AgentAuthProvider | null {
    const existing = this.providers.get(accountId);
    if (existing) return existing;
    const account = this.getAccount(accountId);
    if (!account) return null;
    const provider = this.authProviderFor(account.provider, account.homeDir);
    this.providers.set(accountId, provider);
    this.states.set(accountId, initialState(provider));
    return provider;
  }

  stateFor(accountId: string): ProviderAuthState | null {
    this.ensureProvider(accountId);
    return this.states.get(accountId) ?? null;
  }

  async refresh(accountId: string): Promise<ProviderAuthState | null> {
    const provider = this.ensureProvider(accountId);
    if (!provider) return null;
    const state = await provider.checkAuth();
    this.states.set(accountId, state);
    return state;
  }

  invalidate(accountId: string): void {
    this.providers.delete(accountId);
    this.states.delete(accountId);
  }
}
