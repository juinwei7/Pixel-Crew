/**
 * Pure rules for the quieter NPC habits (no Pixi, unit-tested):
 * leaning back on a long tool call, pacing while thinking hard, a walk to the
 * water cooler after a long stretch of work, the lunch bento, the idle
 * screensaver and the "go make a coffee" errand.
 */

/** A tool call running this long without a result: hands off the keyboard, lean back. */
export const LONG_TOOL_MS = 20_000;

export type ToolWaitTrack = { key: string | null; since: number; leaning: boolean };

export function newToolWait(): ToolWaitTrack {
  return { key: null, since: 0, leaning: false };
}

/**
 * Hysteresis for the lean-back pose. `key` identifies the running tool call
 * (null when not working on one). In at LONG_TOOL_MS; out only when that call
 * ends (key changes / goes null) — never on a timer, so it can't flicker.
 */
export function stepToolWait(track: ToolWaitTrack, key: string | null, nowMs: number): ToolWaitTrack {
  if (key === null) return track.key === null && !track.leaning ? track : newToolWait();
  if (key !== track.key) return { key, since: nowMs, leaning: false };
  if (!track.leaning && nowMs - track.since >= LONG_TOOL_MS) return { ...track, leaning: true };
  return track;
}

/** Thinking at one's own desk this long → get up and pace a little. */
export const PACE_AFTER_MS = 15_000;
/** Never more than this many pacing at once, office-wide. */
export const MAX_PACERS = 2;
/** How far each step goes either side of the seat (art px). */
export const PACE_STEP_PX = 6;
/** Pacing walks at this fraction of normal speed. */
export const PACE_SPEED = 0.4;

export type PaceCandidate = {
  thinkingMs: number;
  station: string;
  atSeat: boolean;
  waiting: boolean;
  busy: boolean;
};

/** May this NPC start pacing? (Meeting table / tool stations never pace.) */
export function mayPace(c: PaceCandidate, pacingNow: number): boolean {
  return pacingNow < MAX_PACERS && c.station === "home" && c.atSeat && !c.waiting && !c.busy &&
    c.thinkingMs >= PACE_AFTER_MS;
}

/** Offsets (art px from the seat) for 2–3 slow steps, alternating sides. `roll` in [0, 1). */
export function pacePlan(roll: number): number[] {
  const first = roll < 0.5 ? PACE_STEP_PX : -PACE_STEP_PX;
  return roll < 0.25 || roll >= 0.75 ? [first, -first, first] : [first, -first];
}

/** Worked at least this long in one go → may wander to the water cooler afterwards. */
export const WATER_AFTER_WORK_MS = 3 * 60_000;
/** Chance a qualifying NPC actually goes (so it stays "now and then"). */
export const WATER_CHANCE = 0.4;
/** Office-wide gap between two water breaks. */
export const WATER_COOLDOWN_MS = 4 * 60_000;
/** Walking to / from the cooler is unhurried. */
export const WATER_SPEED = 0.6;

export function mayFetchWater(workedMs: number, cooldownLeftMs: number, busyElsewhere: boolean, roll: number): boolean {
  return !busyElsewhere && cooldownLeftMs <= 0 && workedMs >= WATER_AFTER_WORK_MS && roll < WATER_CHANCE;
}

/** Local lunch hour: 12:00–13:30. */
export function isLunchTime(now: Date): boolean {
  const m = now.getHours() * 60 + now.getMinutes();
  return m >= 12 * 60 && m < 13 * 60 + 30;
}

/**
 * Share of idle micro-action rolls that become a bento during lunch. It
 * replaces whatever was picked, so the total number of idle acts stays the same.
 */
export const BENTO_SHARE = 0.35;

export function maybeBento<K extends string>(picked: K, bento: K, lunch: boolean, roll: number): K {
  return lunch && roll < BENTO_SHARE ? bento : picked;
}

/** Idle at the desk this long → the monitor drops to a dim screensaver. */
export const SCREENSAVER_AFTER_MS = 5 * 60_000;
/** Brightness of the bouncing dot. */
export const SCREENSAVER_ALPHA = 0.3;

export function screensaverOn(idleMs: number): boolean {
  return idleMs >= SCREENSAVER_AFTER_MS;
}

/** One bounce position: triangle wave from 0 to `span` and back. */
function bounce(t: number, span: number): number {
  if (span <= 0) return 0;
  const p = t % (span * 2);
  return p <= span ? p : span * 2 - p;
}

/**
 * Where the screensaver's dot sits (whole px inside a w×h screen) `tMs` in.
 * Diagonal DVD-style bounce, ~1 px every `stepMs`; different spans on the two
 * axes keep it from retracing one line.
 */
export function screensaverDot(tMs: number, w: number, h: number, stepMs = 700): { x: number; y: number } {
  const n = Math.floor(Math.max(0, tMs) / stepMs);
  return { x: bounce(n, w - 1), y: bounce(n, h - 1) };
}

/** Coffee errand: one per this long, however often the machine is clicked. */
export const COFFEE_ERRAND_COOLDOWN_MS = 20_000;

/** The idle NPC closest to `to`, or null. */
export function nearestTo<T extends { x: number; y: number }>(list: readonly T[], to: { x: number; y: number }): T | null {
  let best: T | null = null;
  let bestD = Infinity;
  for (const item of list) {
    const d = Math.hypot(item.x - to.x, item.y - to.y);
    if (d < bestD) {
      bestD = d;
      best = item;
    }
  }
  return best;
}
