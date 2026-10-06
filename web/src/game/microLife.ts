/**
 * Pure picking rules for the NPCs' small idle / desk habits (see Person.microAct).
 * Kept free of Pixi so the odds and cooldowns can be unit-tested.
 */

/**
 * Chance a micro-action roll becomes a sneeze. Was 0.05 (with ~10 NPCs that
 * meant a sneeze somewhere roughly every 20-40 s); now 5x rarer.
 */
export const SNEEZE_CHANCE = 0.01;
/** The same NPC never sneezes again within this window (also counts from spawn). */
export const SNEEZE_COOLDOWN_MS = 6 * 60_000;

/** May this NPC sneeze now? `roll` is a uniform [0, 1) draw. */
export function maySneeze(nowMs: number, lastSneezeAtMs: number, roll: number): boolean {
  return nowMs - lastSneezeAtMs >= SNEEZE_COOLDOWN_MS && roll < SNEEZE_CHANCE;
}

/**
 * Pick the next micro-action from a pool. Returns "sneeze" only when the
 * sneeze roll and cooldown allow it; acts that need a prop the NPC lacks
 * (pushing up glasses without glasses) fall back to `fallback`.
 */
export function pickMicro<K extends string>(
  pool: readonly K[],
  opts: {
    nowMs: number;
    lastSneezeAtMs: number;
    sneezeRoll: number;
    pickRoll: number;
    wearsGlasses: boolean;
    sneeze: K;
    fallback: K;
    needsGlasses?: K;
  },
): K {
  if (maySneeze(opts.nowMs, opts.lastSneezeAtMs, opts.sneezeRoll)) return opts.sneeze;
  const kind = pool[Math.min(pool.length - 1, Math.floor(opts.pickRoll * pool.length))];
  if (opts.needsGlasses !== undefined && kind === opts.needsGlasses && !opts.wearsGlasses) return opts.fallback;
  return kind;
}
