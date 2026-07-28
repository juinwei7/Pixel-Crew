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
