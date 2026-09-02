import type { RunnerEvent } from "./claudeRunner.js";
import type { AgentSession } from "./providers/session.js";
import type { ProviderId } from "./providers/types.js";
import { replaceWithFreshSession } from "./freshSession.js";
import { t } from "./i18n.js";

export type NativeCommand = "clean";

export function matchNativeCommand(text: string): NativeCommand | null {
  return /^\/clean\b/i.test(text.trim()) ? "clean" : null;
}

/**
 * `/clear` is Pixel Crew's provider-neutral conversation control. Intercept
 * it at the HTTP boundary so neither Claude nor Codex can interpret it as a
 * skill invocation.
 */
export function isClearCommand(text: string): boolean {
  return /^\/clear\s*$/i.test(text.trim());
}

export type GoalCommand =
  | { type: "get" }
  | { type: "clear" }
  | { type: "set"; objective: string };

/** Parse the shared `/goal [objective|clear]` command without consuming normal chat. */
export function parseGoalCommand(text: string): GoalCommand | null {
  const match = text.trim().match(/^\/goal(?:\s+([\s\S]*))?$/i);
  if (!match) return null;
  const argument = (match[1] ?? "").trim();
  if (!argument) return { type: "get" };
  if (argument.toLowerCase() === "clear") return { type: "clear" };
  return { type: "set", objective: argument };
}

export type CleanableWorker = {
  id: string;
  runner: AgentSession;
  history: RunnerEvent[];
};

export type WorkerCleanDeps = {
  isBusy: (worker: CleanableWorker) => boolean;
  createRunner: (provider: ProviderId, workspacePath: string) => AgentSession;
  persistWorker: (worker: CleanableWorker) => boolean;
  saveCheckpoint: (runner: AgentSession) => boolean;
  clearWorkerEvents: (workerId: string) => void;
};

export type CleanResult = { ok: true } | { ok: false; error: string };

export function cleanWorkerSession(worker: CleanableWorker, deps: WorkerCleanDeps): CleanResult {
  if (deps.isBusy(worker)) {
    return { ok: false, error: t("{name} 正在忙碌中", { name: worker.runner.name }) };
  }
  const provider = worker.runner.provider;
  const workspacePath = worker.runner.workspacePath;
  const fresh = replaceWithFreshSession(
    worker,
    worker.runner.getModel() ?? undefined,
    () => deps.createRunner(provider, workspacePath),
    () => deps.persistWorker(worker),
    (runner) => deps.saveCheckpoint(runner),
  );
  if (!fresh) return { ok: false, error: t("無法重建工作階段") };
  worker.history = [];
  deps.clearWorkerEvents(worker.id);
  fresh.warmup();
  return { ok: true };
}
