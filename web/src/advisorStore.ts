// Expert-advisor state lives OUTSIDE React so a running (or finished) proactive
// suggestion survives navigating to another NPC and back. BossTaskDesk unmounts
// whenever the owner leaves the Boss Desk; keeping proposals + the in-flight
// request in component state meant every switch discarded them (and abandoned a
// generation already in progress). This module-level store, keyed by workspace,
// outlives that unmount and is read through useSyncExternalStore.
import type { AdvisorProposal, AdvisorResult, ProviderId } from "./types";
import { apiRequest } from "./api";

export interface RunAdvisorOptions {
  proactive?: boolean;
  provider?: ProviderId;
  model?: string;
}

export interface AdvisorEntry {
  idea: string;
  loading: boolean;
  error: string | null;
  domain: string | null;
  question: string | null;
  proposals: AdvisorProposal[];
  // performance.now() when the current run began; kept so a remount mid-generation
  // resumes the elapsed timer from the real start instead of restarting at 0.
  startedAt: number | null;
  // Params of an in-flight/failed run kept ONLY when it died to a connection blip,
  // so a reconnect can transparently re-run it (the ~110s generation is bound to a
  // live fetch that iOS kills when the tab is backgrounded; there is no other way
  // to recover the result web-side). Cleared the moment a run genuinely completes.
  resume: RunAdvisorOptions | null;
}

const DEFAULT_ENTRY: AdvisorEntry = Object.freeze({
  idea: "",
  loading: false,
  error: null,
  domain: null,
  question: null,
  proposals: [],
  startedAt: null,
  resume: null,
});

const entries = new Map<string, AdvisorEntry>();
const listeners = new Set<() => void>();

// The advisor state is keyed by workspace, but the Boss Desk is opened against
// whichever NPC/workspace is currently active. A user who starts a generation in
// workspace A, then switches to a department in workspace B, would otherwise read
// B's (empty) entry and think the generation vanished — it only reappears after
// switching back to A. `pinnedWorkspace` records the workspace whose advisor run is
// in flight (or most recently produced a result), so the Boss Desk can surface that
// generation regardless of the active workspace, pinned to the workspace that
// started it (its objective/context belongs to that workspace). A newer run in
// another workspace overwrites the pin; it is released once the result is created
// as a task or explicitly dismissed.
let pinnedWorkspace: string | null = null;

function emit(): void {
  for (const listener of listeners) listener();
}

export function subscribeAdvisor(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

// Returns a stable reference while the entry is unchanged (required by
// useSyncExternalStore's getSnapshot); the shared frozen default covers workspaces
// that have never run the advisor.
export function getAdvisorEntry(workspacePath: string): AdvisorEntry {
  return entries.get(workspacePath) ?? DEFAULT_ENTRY;
}

// The workspace whose advisor generation the Boss Desk should surface regardless
// of which workspace is active — the pinned one, but ONLY while its entry is still
// meaningful (running, or holding proposals/a clarifying question/an error). Once
// that entry is consumed or reset the pin goes inert and callers fall back to the
// active workspace. Returns a primitive (string | null), so it is a stable snapshot
// for useSyncExternalStore between emits (getSnapshot stays pure — no mutation).
export function getActiveAdvisorWorkspace(): string | null {
  if (!pinnedWorkspace) return null;
  const entry = entries.get(pinnedWorkspace);
  if (!entry) return null;
  const active = entry.loading || entry.proposals.length > 0 || entry.question != null || entry.error != null;
  return active ? pinnedWorkspace : null;
}

// Release the pin (revert the Boss Desk to the active workspace). `clearEntry`
// additionally wipes the workspace's advisor state — used by the explicit "use the
// current workspace instead" dismiss so the stale proposals disappear; a plain
// release (after a task is created from the result) leaves the entry intact so
// returning to that workspace still shows what was generated there.
export function releaseAdvisorPin(workspacePath: string, clearEntry = false): void {
  let changed = false;
  if (pinnedWorkspace === workspacePath) { pinnedWorkspace = null; changed = true; }
  if (clearEntry && entries.has(workspacePath)) { entries.set(workspacePath, DEFAULT_ENTRY); changed = true; }
  if (changed) emit();
}

function update(workspacePath: string, patch: Partial<AdvisorEntry>): void {
  const current = entries.get(workspacePath) ?? DEFAULT_ENTRY;
  entries.set(workspacePath, { ...current, ...patch });
  emit();
}

export function setAdvisorIdea(workspacePath: string, idea: string): void {
  update(workspacePath, { idea });
}

// A failed advisor run leaves its error pinned until the next run — so one
// transient network blip (iOS suspending the tab mid-generation, a 5G hiccup)
// leaves "無法連線到 Pixel Crew Server" on screen forever, long after the server
// is reachable again. The WS (re)connecting is the authoritative "we're online
// now" signal, so clear any lingering error there. Skip entries still loading
// (their run is genuinely in flight); the finally-block owns their outcome.
export function clearAdvisorErrors(): void {
  let changed = false;
  for (const [workspacePath, entry] of entries) {
    if (entry.error && !entry.loading) {
      entries.set(workspacePath, { ...entry, error: null });
      changed = true;
    }
  }
  if (changed) emit();
}

// api.ts throws these (connection refused / request timed out) as the ApiRequestError
// message; both phrasings contain "Pixel Crew Server" in every locale. We treat only
// this family as "interrupted, safe to auto-retry" — a real server-side advisor error
// carries the backend's own message and must NOT loop the LLM on every reconnect.
function isConnectionFailure(message: string): boolean {
  return message.includes("Pixel Crew Server");
}

export async function runAdvisor(workspacePath: string, options: RunAdvisorOptions = {}): Promise<void> {
  const entry = entries.get(workspacePath) ?? DEFAULT_ENTRY;
  const idea = entry.idea.trim();
  const proactive = Boolean(options.proactive);
  // proactive（主動建議）不需要念頭；一般模式仍要有念頭。已在跑就別重入。
  if ((!idea && !proactive) || entry.loading) return;
  // Pin the Boss Desk to this workspace so the generation stays visible after the
  // user switches to an NPC in another workspace (a newer run elsewhere re-pins).
  pinnedWorkspace = workspacePath;
  update(workspacePath, { loading: true, error: null, proposals: [], question: null, domain: null, startedAt: performance.now(), resume: { proactive, provider: options.provider, model: options.model } });
  try {
    const data = await apiRequest<{ result: AdvisorResult }>("/api/advisor/propose", {
      method: "POST",
      body: { idea, workspacePath, provider: options.provider, model: options.model, proactive },
      // 生成方向較慢（冷啟＋思考＋4 段內容），逾時要比 server 的 150s 長，否則前端先斷。
      timeoutMs: 160_000,
    });
    if (data.result.status === "need_focus") {
      update(workspacePath, { question: data.result.question, resume: null });
    } else {
      update(workspacePath, { proposals: data.result.proposals, domain: data.result.domain || null, resume: null });
    }
  } catch (advisorFailure) {
    const message = (advisorFailure as Error).message;
    // Keep resume params only for a connection blip so a reconnect can pick it back
    // up; drop them for genuine failures so we don't re-run the LLM in a loop.
    update(workspacePath, { error: message, resume: isConnectionFailure(message) ? (entries.get(workspacePath) ?? DEFAULT_ENTRY).resume : null });
  } finally {
    update(workspacePath, { loading: false, startedAt: null });
  }
}

// Called when the WS reconnects: any advisor run that died to a connection blip
// (resume params retained, not currently loading) is transparently re-run, so a
// user who backgrounded the app mid-generation returns to it finishing on its own
// instead of a dead "無法連線" error. Success clears resume, so this can't loop.
export function resumeAdvisorRuns(): void {
  for (const [workspacePath, entry] of [...entries]) {
    if (entry.resume && !entry.loading) void runAdvisor(workspacePath, entry.resume);
  }
}
