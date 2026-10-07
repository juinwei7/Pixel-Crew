import type { AgentSession } from "./providers/session.js";

export type FreshSessionWorker = { runner: AgentSession };

type PersistFreshSession = (runner: AgentSession) => boolean;

export function replaceWithFreshSession(
  worker: FreshSessionWorker,
  model: string | undefined,
  createFreshRunner: () => AgentSession,
  persistWorker: PersistFreshSession,
  persistCheckpoint: PersistFreshSession,
  discardPreviousCheckpoint: (runner: AgentSession) => boolean = () => true,
): AgentSession | null {
  const previous = worker.runner;
  const fresh = createFreshRunner();
  fresh.name = previous.name;
  fresh.setModel(model);

  previous.stop();
  worker.runner = fresh;

  if (persistWorker(fresh) && persistCheckpoint(fresh) && discardPreviousCheckpoint(previous)) return fresh;

  fresh.stop();
  worker.runner = previous;
  // Best-effort rollback: restore both records so a partial first write cannot
  // make a restart revive the discarded replacement session.
  persistWorker(previous);
  persistCheckpoint(previous);
  return null;
}

/**
 * 換帳號同時重置對話（帳號切換的 force 路徑）。順序是重點：先把 accountId 換成新帳號再重置——
 * 重置會當場暖機新的 runner，若還掛著舊帳號，新 CLI 就生在舊帳號的 CLAUDE_CONFIG_DIR／CODEX_HOME
 * 裡（用量卻記到新帳號頭上，下次重生時 --resume 在新帳號 home 找不到對話、整段上下文消失）。
 * 重置失敗就把帳號還原，比照 /provider/fresh 的先換後回滾。
 */
export function switchAccountWithReset<T extends { accountId: string | null }>(
  worker: T,
  accountId: string | null,
  reset: () => { ok: true } | { ok: false; error: string },
): { ok: true } | { ok: false; error: string } {
  const previous = worker.accountId;
  worker.accountId = accountId;
  const result = reset();
  if (!result.ok) worker.accountId = previous;
  return result;
}
