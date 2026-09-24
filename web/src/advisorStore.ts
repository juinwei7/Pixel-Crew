// Expert-advisor state lives OUTSIDE React so a running (or finished) proactive
// suggestion survives navigating to another NPC and back. BossTaskDesk unmounts
// whenever the owner leaves the Boss Desk; keeping proposals + the in-flight
// request in component state meant every switch discarded them (and abandoned a
// generation already in progress). This module-level store, keyed by workspace,
// outlives that unmount and is read through useSyncExternalStore.
import type { AdvisorProposal, AdvisorResult, ProviderId } from "./types";
import { apiRequest } from "./api";

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
}

const DEFAULT_ENTRY: AdvisorEntry = Object.freeze({
  idea: "",
  loading: false,
  error: null,
  domain: null,
  question: null,
  proposals: [],
  startedAt: null,
});

const entries = new Map<string, AdvisorEntry>();
const listeners = new Set<() => void>();

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

function update(workspacePath: string, patch: Partial<AdvisorEntry>): void {
  const current = entries.get(workspacePath) ?? DEFAULT_ENTRY;
  entries.set(workspacePath, { ...current, ...patch });
  emit();
}

export function setAdvisorIdea(workspacePath: string, idea: string): void {
  update(workspacePath, { idea });
}

export interface RunAdvisorOptions {
  proactive?: boolean;
  provider?: ProviderId;
  model?: string;
}

export async function runAdvisor(workspacePath: string, options: RunAdvisorOptions = {}): Promise<void> {
  const entry = entries.get(workspacePath) ?? DEFAULT_ENTRY;
  const idea = entry.idea.trim();
  const proactive = Boolean(options.proactive);
  // proactive（主動建議）不需要念頭；一般模式仍要有念頭。已在跑就別重入。
  if ((!idea && !proactive) || entry.loading) return;
  update(workspacePath, { loading: true, error: null, proposals: [], question: null, domain: null, startedAt: performance.now() });
  try {
    const data = await apiRequest<{ result: AdvisorResult }>("/api/advisor/propose", {
      method: "POST",
      body: { idea, workspacePath, provider: options.provider, model: options.model, proactive },
      // 生成方向較慢（冷啟＋思考＋4 段內容），逾時要比 server 的 150s 長，否則前端先斷。
      timeoutMs: 160_000,
    });
    if (data.result.status === "need_focus") {
      update(workspacePath, { question: data.result.question });
    } else {
      update(workspacePath, { proposals: data.result.proposals, domain: data.result.domain || null });
    }
  } catch (advisorFailure) {
    update(workspacePath, { error: (advisorFailure as Error).message });
  } finally {
    update(workspacePath, { loading: false, startedAt: null });
  }
}
