// A department mission moving forward is the team's win, not one NPC's: when a
// step completes the whole department gives a thumbs up, and when the last
// step lands everyone cheers. Event-driven only — nothing plays while idle.

export type MissionCheerInput = {
  id: string;
  temporary: boolean;
  departmentKey?: string;
  missionProgress?: { completed: number; total: number } | null;
};

export type MissionCheer = { key: string; kind: "step" | "done"; ids: string[] };

/**
 * Compare each department's completed-step count with the last one seen.
 * Only an increase on a mission we already knew about cheers, so a page load,
 * a reconnect snapshot or a freshly started mission stays quiet. Departments
 * without an active mission drop out of the map, which resets the baseline.
 */
export function missionCheers(
  seen: ReadonlyMap<string, number>,
  list: readonly MissionCheerInput[],
): { seen: Map<string, number>; cheers: MissionCheer[] } {
  const progress = new Map<string, { completed: number; total: number }>();
  const members = new Map<string, string[]>();
  for (const worker of list) {
    if (worker.temporary || !worker.departmentKey) continue;
    const ids = members.get(worker.departmentKey) ?? [];
    ids.push(worker.id);
    members.set(worker.departmentKey, ids);
    if (worker.missionProgress && !progress.has(worker.departmentKey)) progress.set(worker.departmentKey, worker.missionProgress);
  }
  const next = new Map<string, number>();
  const cheers: MissionCheer[] = [];
  for (const [key, { completed, total }] of progress) {
    next.set(key, completed);
    const before = seen.get(key);
    if (before === undefined || completed <= before) continue;
    cheers.push({ key, kind: completed >= total ? "done" : "step", ids: members.get(key) ?? [] });
  }
  return { seen: next, cheers };
}
