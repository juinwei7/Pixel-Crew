import { createInterface } from "node:readline";
import { config } from "./config.js";
import type { AuthStatus, ProviderId } from "./providers/types.js";
import type { LocalStore } from "./store.js";
import type { ProviderAccount } from "./store.js";
import { execCli, spawnCli, terminateProcessTree } from "./platform/processes.js";
import { codexChildEnv } from "./codexEnv.js";
import { claudeChildEnv } from "./claudeEnv.js";
import { t } from "./i18n.js";
const PROVIDERS: ProviderId[] = ["claude", "codex"];

export type UsageWindow = {
  id: string;
  label: string;
  usedPercent: number;
  remainingPercent: number;
  resetsAt: string | null;
  scope: "session" | "weekly" | "model" | "rate";
};

export type ProviderUsageState = {
  provider: ProviderId;
  windows: UsageWindow[];
  loading: boolean;
  source: "empty" | "cache" | "live";
  updatedAt: string | null;
  error: string | null;
};

function emptyState(provider: ProviderId): ProviderUsageState {
  return { provider, windows: [], loading: false, source: "empty", updatedAt: null, error: null };
}

function percent(value: unknown): number {
  const parsed = Number(value);
  return Math.max(0, Math.min(100, Number.isFinite(parsed) ? Math.round(parsed) : 0));
}

function safeText(value: unknown, max = 160): string {
  return String(value ?? "").trim().slice(0, max);
}

export function parseClaudeUsage(raw: string): UsageWindow[] {
  let result = raw;
  try {
    const parsed = JSON.parse(raw) as { result?: unknown };
    if (typeof parsed.result === "string") result = parsed.result;
  } catch {
    // Tests and older CLI versions may provide the human-readable result directly.
  }
  const windows: UsageWindow[] = [];
  const pattern = /^(Current [^:]+):\s*(\d+)% used\s*[·-]\s*resets\s+(.+)$/gim;
  for (const match of result.matchAll(pattern)) {
    const sourceLabel = safeText(match[1], 80);
    const usedPercent = percent(match[2]);
    const lower = sourceLabel.toLowerCase();
    const scope: UsageWindow["scope"] = lower === "current session"
      ? "session"
      : lower.includes("all models")
        ? "weekly"
        : lower.startsWith("current week")
          ? "model"
          : "rate";
    const modelMatch = sourceLabel.match(/\(([^)]+)\)/);
    const label = scope === "session" ? t("本次時段") : scope === "weekly" ? t("本週") : modelMatch?.[1] ?? sourceLabel.replace(/^Current\s+/i, "");
    windows.push({
      id: `claude-${scope}-${windows.length}`,
      label: safeText(label, 40),
      usedPercent,
      remainingPercent: 100 - usedPercent,
      resetsAt: safeText(match[3], 120) || null,
      scope,
    });
  }
  return windows;
}

type CodexRateWindow = { usedPercent?: unknown; resetsAt?: unknown; windowDurationMins?: unknown };
type CodexRateSnapshot = {
  limitId?: unknown;
  limitName?: unknown;
  primary?: CodexRateWindow | null;
  secondary?: CodexRateWindow | null;
};

function codexWindowLabel(window: CodexRateWindow, fallback: string): string {
  const minutes = Number(window.windowDurationMins);
  if (!Number.isFinite(minutes) || minutes <= 0) return fallback;
  if (minutes < 60) return t("{n} 分鐘", { n: minutes });
  if (minutes < 1440) return t("{n} 小時", { n: Math.round(minutes / 60) });
  return t("{n} 天", { n: Math.round(minutes / 1440) });
}

function codexResetTime(value: unknown): string | null {
  if (value == null) return null;
  const epochSeconds = Number(value);
  if (!Number.isFinite(epochSeconds) || epochSeconds <= 0) return null;
  const date = new Date(epochSeconds * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function normalizeCodexUsage(payload: any): UsageWindow[] {
  const snapshots: CodexRateSnapshot[] = [];
  if (payload?.rateLimits && typeof payload.rateLimits === "object") snapshots.push(payload.rateLimits);
  if (payload?.rateLimitsByLimitId && typeof payload.rateLimitsByLimitId === "object") {
    snapshots.push(...Object.values(payload.rateLimitsByLimitId) as CodexRateSnapshot[]);
  }
  const windows: UsageWindow[] = [];
  const seen = new Set<string>();
  for (const [snapshotIndex, snapshot] of snapshots.entries()) {
    for (const [kind, value] of [["primary", snapshot.primary], ["secondary", snapshot.secondary]] as const) {
      if (!value || value.usedPercent == null) continue;
      const id = `${safeText(snapshot.limitId || snapshot.limitName || snapshotIndex, 60)}-${kind}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const usedPercent = percent(value.usedPercent);
      windows.push({
        id: `codex-${id}`,
        label: codexWindowLabel(value, kind === "primary" ? t("短期") : t("長期")),
        usedPercent,
        remainingPercent: 100 - usedPercent,
        resetsAt: codexResetTime(value.resetsAt),
        scope: "rate",
      });
    }
  }
  return windows;
}

async function readClaudeUsage(claudeHome = config.defaultClaudeHome): Promise<UsageWindow[]> {
  const { stdout } = await execCli(config.claudeBin, ["-p", "/usage", "--output-format", "json"], {
    cwd: config.targetRepoPath,
    timeout: 30_000,
    maxBuffer: 1_000_000,
    env: claudeChildEnv(process.env, claudeHome),
  });
  const windows = parseClaudeUsage(stdout);
  if (windows.length === 0) throw new Error(t("Claude /usage 沒有回傳可辨識的用量區間"));
  return windows;
}

async function readCodexUsage(codexHome = config.defaultCodexHome): Promise<UsageWindow[]> {
  return new Promise((resolve, reject) => {
    const child = spawnCli(config.codexBin, ["app-server"], {
      cwd: config.targetRepoPath,
      env: codexChildEnv(process.env, codexHome),
    });
    const rl = createInterface({ input: child.stdout });
    let settled = false;
    let stderr = "";
    const finish = (error?: Error, windows?: UsageWindow[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rl.close();
      void terminateProcessTree(child);
      if (error) reject(error);
      else resolve(windows ?? []);
    };
    const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);
    const timer = setTimeout(() => finish(new Error(t("Codex 用量查詢逾時"))), 20_000);
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk.toString()}`.slice(-4_000); });
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      if (!settled) finish(new Error(stderr.trim() || `codex app-server exited with code ${code}`));
    });
    rl.on("line", (line) => {
      let message: any;
      try { message = JSON.parse(line); } catch { return; }
      if (message.id === 1) {
        if (message.error) { finish(new Error(safeText(message.error.message, 300))); return; }
        send({ method: "initialized", params: {} });
        send({ method: "account/rateLimits/read", id: 2, params: null });
      } else if (message.id === 2) {
        if (message.error) { finish(new Error(safeText(message.error.message, 300))); return; }
        const windows = normalizeCodexUsage(message.result);
        if (windows.length === 0) finish(new Error(t("Codex 沒有回傳可用的 rate-limit 區間")));
        else finish(undefined, windows);
      }
    });
    send({ method: "initialize", id: 1, params: { clientInfo: { name: "pixel_crew", title: "Pixel Crew", version: "0.1.0" } } });
  });
}

async function readUsage(provider: ProviderId, homeDir: string): Promise<UsageWindow[]> {
  return provider === "claude" ? readClaudeUsage(homeDir) : readCodexUsage(homeDir);
}

function idleState(provider: ProviderId, value: unknown): ProviderUsageState {
  if (!value || typeof value !== "object") return emptyState(provider);
  const state = value as Partial<ProviderUsageState>;
  const windows = Array.isArray(state.windows) ? state.windows.filter((window) => window && typeof window === "object") as UsageWindow[] : [];
  return { provider, windows, loading: false, source: windows.length ? "cache" : "empty", updatedAt: safeText(state.updatedAt) || null, error: null };
}

export class ProviderUsageRegistry {
  private states: Record<ProviderId, ProviderUsageState>;
  private active = new Map<ProviderId, Promise<ProviderUsageState>>();

  constructor(
    private readonly store: LocalStore,
    private readonly onUpdate: (state: ProviderUsageState) => void,
    // Usage is read by spawning the provider CLI. We only do that once the
    // provider is authenticated/started, so a signed-out Claude is never
    // woken up just to draw the energy panel. Defaults to always-ready.
    // Takes the *status*, not a plain ready/not-ready boolean, so refresh()
    // can tell "still checking" (transient — keep showing the last windows
    // untouched, same as before) apart from "confirmed not authenticated"
    // (the cached windows are from a since-ended session and must not keep
    // being presented as "live").
    private readonly getAuthStatus: (provider: ProviderId) => AuthStatus = () => "authenticated",
  ) {
    this.states = {
      claude: idleState("claude", store.loadProviderUsage("claude")),
      codex: idleState("codex", store.loadProviderUsage("codex")),
    };
  }

  getStates(): Record<ProviderId, ProviderUsageState> {
    return this.states;
  }

  refresh(provider: ProviderId, force = false): Promise<ProviderUsageState> {
    const running = this.active.get(provider);
    if (running) return running;
    const previous = this.states[provider];
    const status = this.getAuthStatus(provider);
    if (status === "checking") {
      // Transient — a real answer is imminent (e.g. the 3s re-poll while
      // unauthenticated). Keep whatever was already shown untouched so this
      // doesn't flicker the same way the auth badge itself used to.
      const idle: ProviderUsageState = { ...previous, loading: false, error: null };
      if (previous.loading || previous.error) this.publish(idle, false);
      return Promise.resolve(idle);
    }
    if (status !== "authenticated") {
      // Confirmed signed out (unauthenticated/cli_missing/error) — never
      // spawn the CLI, and if we're still holding onto a previous session's
      // "live" windows, relabel them "cache" so the UI shows the existing
      // 快取 badge instead of implying the numbers are current. Persist the
      // relabel too, so a page reload before the next real fetch doesn't
      // flash the stale "live" label again.
      const relabeled: ProviderUsageState = previous.windows.length > 0 && previous.source === "live"
        ? { ...previous, loading: false, error: null, source: "cache" }
        : { ...previous, loading: false, error: null };
      if (previous.loading || previous.error || previous.source !== relabeled.source) {
        this.publish(relabeled, previous.source !== relabeled.source);
      }
      return Promise.resolve(relabeled);
    }
    if (!force && previous.updatedAt && Date.now() - Date.parse(previous.updatedAt) < 60_000) return Promise.resolve(previous);
    this.publish({ ...previous, loading: true, error: null }, false);
    const operation = (provider === "claude" ? readClaudeUsage() : readCodexUsage())
      .then((windows) => {
        const state: ProviderUsageState = { provider, windows, loading: false, source: "live", updatedAt: new Date().toISOString(), error: null };
        this.publish(state, true);
        return state;
      })
      .catch((error) => {
        const state: ProviderUsageState = { ...this.states[provider], loading: false, error: safeText((error as Error).message, 300) || t("無法讀取工作能量") };
        this.publish(state, false);
        return state;
      })
      .finally(() => this.active.delete(provider));
    this.active.set(provider, operation);
    return operation;
  }

  async refreshAll(force = false): Promise<Record<ProviderId, ProviderUsageState>> {
    await Promise.all(PROVIDERS.map((provider) => this.refresh(provider, force)));
    return this.states;
  }

  private publish(state: ProviderUsageState, persist: boolean): void {
    this.states = { ...this.states, [state.provider]: state };
    if (persist) this.store.saveProviderUsage(state.provider, state);
    this.onUpdate(state);
  }
}

/**
 * Named logins each have an isolated CLI home, so their subscription limits
 * must be queried independently. This deliberately stays in memory: unlike
 * the default slot, an account can be removed at any time and its old quota
 * must not reappear after a restart as if it still belonged to a live login.
 */
export class AccountUsageRegistry {
  private states: Record<string, ProviderUsageState> = {};
  private active = new Map<string, Promise<ProviderUsageState>>();

  constructor(
    private readonly listAccounts: () => ProviderAccount[],
    private readonly getAuthStatus: (accountId: string) => AuthStatus | null,
    private readonly onUpdate: (accountId: string, state: ProviderUsageState) => void,
    private readonly reader: (provider: ProviderId, homeDir: string) => Promise<UsageWindow[]> = readUsage,
  ) {}

  getStates(): Record<string, ProviderUsageState> {
    return this.states;
  }

  remove(accountId: string): void {
    this.active.delete(accountId);
    if (!(accountId in this.states)) return;
    const { [accountId]: _removed, ...remaining } = this.states;
    this.states = remaining;
  }

  refresh(accountId: string, force = false): Promise<ProviderUsageState> {
    const running = this.active.get(accountId);
    if (running) return running;
    const account = this.listAccounts().find((candidate) => candidate.id === accountId);
    if (!account) return Promise.resolve(emptyState("claude"));
    const previous = this.states[accountId] ?? emptyState(account.provider);
    const status = this.getAuthStatus(accountId);
    if (status === "checking" || status == null) {
      const idle = { ...previous, loading: false, error: null };
      if (previous.loading || previous.error) this.publish(accountId, idle);
      return Promise.resolve(idle);
    }
    if (status !== "authenticated") {
      const relabeled = previous.windows.length > 0 && previous.source === "live"
        ? { ...previous, loading: false, error: null, source: "cache" as const }
        : { ...previous, loading: false, error: null };
      if (previous.loading || previous.error || previous.source !== relabeled.source) this.publish(accountId, relabeled);
      return Promise.resolve(relabeled);
    }
    if (!force && previous.updatedAt && Date.now() - Date.parse(previous.updatedAt) < 60_000) return Promise.resolve(previous);
    this.publish(accountId, { ...previous, loading: true, error: null });
    const operation = this.reader(account.provider, account.homeDir)
      .then((windows) => {
        const state: ProviderUsageState = { provider: account.provider, windows, loading: false, source: "live", updatedAt: new Date().toISOString(), error: null };
        // An account could be deleted while its CLI query is still running.
        if (this.listAccounts().some((candidate) => candidate.id === accountId)) this.publish(accountId, state);
        return state;
      })
      .catch((error) => {
        const state: ProviderUsageState = { ...this.states[accountId] ?? previous, loading: false, error: safeText((error as Error).message, 300) || t("無法讀取工作能量") };
        if (this.listAccounts().some((candidate) => candidate.id === accountId)) this.publish(accountId, state);
        return state;
      })
      .finally(() => this.active.delete(accountId));
    this.active.set(accountId, operation);
    return operation;
  }

  async refreshAll(force = false): Promise<Record<string, ProviderUsageState>> {
    await Promise.all(this.listAccounts().map((account) => this.refresh(account.id, force)));
    return this.states;
  }

  private publish(accountId: string, state: ProviderUsageState): void {
    this.states = { ...this.states, [accountId]: state };
    this.onUpdate(accountId, state);
  }
}
