import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { config } from "./config.js";
import type { AuthStatus, ProviderId } from "./providers/types.js";
import type { LocalStore } from "./store.js";
import type { ProviderAccount } from "./store.js";
import { spawnCli, terminateProcessTree } from "./platform/processes.js";
import { codexChildEnv } from "./codexEnv.js";
import { claudeChildEnv } from "./claudeEnv.js";
import { ensurePrivateDirectorySync } from "./platform/fileProtection.js";
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

// Codex's app-server only reports a raw window duration (e.g. 300 minutes),
// with no semantic name — but its primary/secondary windows are the same
// concept as Claude's session/week limits, so label them the same way
// instead of surfacing the literal duration. "本週期" (not "本週") because a
// plan's secondary window isn't guaranteed to be exactly seven days.
function codexWindowLabel(kind: "primary" | "secondary"): string {
  return kind === "primary" ? t("本次時段") : t("本週期");
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
    // Multiple rate-limit groups (distinct model tiers each with their own
    // primary/secondary quota) would otherwise all produce an identical
    // "本次時段"/"本週期" label with no way to tell which pool is which.
    const qualifier = snapshots.length > 1 ? safeText(snapshot.limitId || snapshot.limitName || `#${snapshotIndex + 1}`, 40) : null;
    for (const [kind, value] of [["primary", snapshot.primary], ["secondary", snapshot.secondary]] as const) {
      if (!value || value.usedPercent == null) continue;
      const id = `${safeText(snapshot.limitId || snapshot.limitName || snapshotIndex, 60)}-${kind}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const usedPercent = percent(value.usedPercent);
      const label = codexWindowLabel(kind);
      windows.push({
        id: `codex-${id}`,
        label: qualifier ? `${label} · ${qualifier}` : label,
        usedPercent,
        remainingPercent: 100 - usedPercent,
        resetsAt: codexResetTime(value.resetsAt),
        scope: "rate",
      });
    }
  }
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

/**
 * Claude's `/usage` only returns real quota text inside a session that
 * already has at least one completed turn — a brand-new session's first
 * turn gets an empty SDK result instead (verified against the real CLI).
 * So each account gets one hidden, UI-invisible "shadow" session: bootstrap
 * it once with a trivial real turn, then forever `--resume` it to ask
 * `/usage` in a fresh headless process. `/usage` itself never reaches the
 * model (the CLI answers it locally — $0 cost, near-instant), so only the
 * one-time bootstrap per account costs anything.
 */
function probeWorkspaceDir(): string {
  const dir = join(config.dataDirectory, "usage-probe-workspace");
  ensurePrivateDirectorySync(dir);
  return dir;
}

type HeadlessTurnResult = { resultText: string };

/** Spawns `claude -p` for exactly one turn, feeds it one message, and resolves with the final `result` line's text. */
function runHeadlessClaudeTurn(args: string[], env: NodeJS.ProcessEnv, messageText: string): Promise<HeadlessTurnResult> {
  return new Promise((resolve, reject) => {
    const child = spawnCli(config.claudeBin, args, { cwd: probeWorkspaceDir(), env });
    const rl = createInterface({ input: child.stdout });
    let settled = false;
    let stderr = "";
    const finish = (error?: Error, result?: HeadlessTurnResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rl.close();
      void terminateProcessTree(child);
      if (error) reject(error);
      else resolve(result!);
    };
    const timer = setTimeout(() => finish(new Error(t("Claude 用量查詢逾時"))), 30_000);
    child.stdin.on("error", () => {});
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk.toString()}`.slice(-4_000); });
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      if (!settled) finish(new Error(stderr.trim() || `claude exited with code ${code}`));
    });
    rl.on("line", (line) => {
      if (settled || !line.trim()) return;
      let parsed: any;
      try { parsed = JSON.parse(line); } catch { return; }
      if (parsed.type !== "result") return;
      const isError = Boolean(parsed.is_error) || String(parsed.subtype ?? "").startsWith("error");
      const resultText = String(
        parsed.result
        ?? parsed.error?.message
        ?? parsed.message
        ?? (Array.isArray(parsed.errors) ? parsed.errors.join("; ") : "")
        ?? "",
      );
      if (isError) finish(new Error(safeText(resultText, 300) || t("Claude 用量查詢失敗")));
      else finish(undefined, { resultText });
    });
    child.stdin.write(`${JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: messageText }] },
    })}\n`);
    child.stdin.end();
  });
}

async function bootstrapClaudeProbeSession(homeDir: string): Promise<string> {
  const sessionId = randomUUID();
  const args = [
    "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
    "--permission-mode", "plan", "--model", "haiku", "--session-id", sessionId,
  ];
  await runHeadlessClaudeTurn(args, claudeChildEnv(process.env, homeDir), "Reply with exactly: OK");
  return sessionId;
}

// A stale probe session (its transcript deleted out from under it, e.g. by
// the user clearing Claude's own session history) fails --resume outright;
// forget it so the next refresh cycle bootstraps a fresh one automatically
// instead of erroring forever.
function looksLikeMissingSession(message: string): boolean {
  return /no conversation found|session .*not found|could not find|invalid session/i.test(message);
}

export async function readClaudeUsage(accountKey: string, homeDir: string, store: LocalStore): Promise<UsageWindow[]> {
  let sessionId = store.loadClaudeUsageProbeSession(accountKey);
  if (!sessionId) {
    sessionId = await bootstrapClaudeProbeSession(homeDir);
    store.saveClaudeUsageProbeSession(accountKey, sessionId);
  }
  const args = [
    "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
    "--permission-mode", "plan", "--resume", sessionId,
  ];
  try {
    const { resultText } = await runHeadlessClaudeTurn(args, claudeChildEnv(process.env, homeDir), "/usage");
    const windows = parseClaudeUsage(resultText);
    if (windows.length === 0) throw new Error(t("Claude 沒有回傳可用的訂閱用量"));
    return windows;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (looksLikeMissingSession(message)) store.deleteClaudeUsageProbeSession(accountKey);
    throw error instanceof Error ? error : new Error(message);
  }
}

/** One query strategy per provider — Codex is a stateless RPC call, Claude drives its own hidden session. */
export interface UsageSource {
  fetch(homeDir: string, accountKey: string, store: LocalStore): Promise<UsageWindow[]>;
}

export const codexUsageSource: UsageSource = {
  fetch: (homeDir) => readCodexUsage(homeDir),
};

export const claudeUsageSource: UsageSource = {
  fetch: (homeDir, accountKey, store) => readClaudeUsage(accountKey, homeDir, store),
};

export function usageSourceFor(provider: ProviderId): UsageSource {
  return provider === "claude" ? claudeUsageSource : codexUsageSource;
}

// Shared by ProviderUsageRegistry (default slot) and AccountUsageRegistry
// (named accounts) — both need the exact same "still checking auth? keep
// waiting; confirmed signed out? relabel any stale 'live' windows as
// 'cache'; otherwise throttle to one live fetch per 60s" decision, they just
// differ in *how* a decision gets published/persisted.
type RefreshDecision =
  | { action: "keep" }
  | { action: "settle"; state: ProviderUsageState; sourceChanged: boolean }
  | { action: "cached" }
  | { action: "fetch" };

function decideRefresh(previous: ProviderUsageState, status: AuthStatus | null, force: boolean): RefreshDecision {
  if (status === "checking" || status == null) {
    // Transient — a real answer is imminent (e.g. the 3s re-poll while
    // unauthenticated). Keep whatever was already shown untouched so this
    // doesn't flicker the same way the auth badge itself used to.
    if (!previous.loading && !previous.error) return { action: "keep" };
    return { action: "settle", state: { ...previous, loading: false, error: null }, sourceChanged: false };
  }
  if (status !== "authenticated") {
    // Confirmed signed out (unauthenticated/cli_missing/error) — never
    // spawn the CLI, and if we're still holding onto a previous session's
    // "live" windows, relabel them "cache" so the UI shows the existing
    // 快取 badge instead of implying the numbers are current.
    const relabeled: ProviderUsageState = previous.windows.length > 0 && previous.source === "live"
      ? { ...previous, loading: false, error: null, source: "cache" }
      : { ...previous, loading: false, error: null };
    if (!previous.loading && !previous.error && previous.source === relabeled.source) return { action: "keep" };
    return { action: "settle", state: relabeled, sourceChanged: previous.source !== relabeled.source };
  }
  if (!force && previous.updatedAt && Date.now() - Date.parse(previous.updatedAt) < 60_000) return { action: "cached" };
  return { action: "fetch" };
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

  /** Stores a quota snapshot returned by `/usage` inside an existing Claude session. */
  report(provider: ProviderId, windows: UsageWindow[]): ProviderUsageState {
    if (windows.length === 0) return this.states[provider];
    const state: ProviderUsageState = {
      provider,
      windows,
      loading: false,
      source: "live",
      updatedAt: new Date().toISOString(),
      error: null,
    };
    this.publish(state, true);
    return state;
  }

  refresh(provider: ProviderId, force = false): Promise<ProviderUsageState> {
    const running = this.active.get(provider);
    if (running) return running;
    const previous = this.states[provider];
    const decision = decideRefresh(previous, this.getAuthStatus(provider), force);
    if (decision.action === "keep" || decision.action === "cached") return Promise.resolve(previous);
    if (decision.action === "settle") {
      this.publish(decision.state, decision.sourceChanged);
      return Promise.resolve(decision.state);
    }
    this.publish({ ...previous, loading: true, error: null }, false);
    const homeDir = provider === "claude" ? config.defaultClaudeHome : config.defaultCodexHome;
    const operation = usageSourceFor(provider).fetch(homeDir, "default", this.store)
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
 * Named logins each have an isolated CLI home, so Codex limits
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
    private readonly reader: (provider: ProviderId, homeDir: string, accountId: string) => Promise<UsageWindow[]>,
  ) {}

  getStates(): Record<string, ProviderUsageState> {
    return this.states;
  }

  /** Stores a quota snapshot for one named account, without mixing accounts. */
  report(accountId: string, windows: UsageWindow[]): ProviderUsageState | null {
    const account = this.listAccounts().find((candidate) => candidate.id === accountId);
    if (!account || windows.length === 0) return this.states[accountId] ?? null;
    const state: ProviderUsageState = {
      provider: account.provider,
      windows,
      loading: false,
      source: "live",
      updatedAt: new Date().toISOString(),
      error: null,
    };
    this.publish(accountId, state);
    return state;
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
    const decision = decideRefresh(previous, this.getAuthStatus(accountId), force);
    if (decision.action === "keep" || decision.action === "cached") return Promise.resolve(previous);
    if (decision.action === "settle") {
      this.publish(accountId, decision.state);
      return Promise.resolve(decision.state);
    }
    this.publish(accountId, { ...previous, loading: true, error: null });
    const operation = this.reader(account.provider, account.homeDir, accountId)
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
