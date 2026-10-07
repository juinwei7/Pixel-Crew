import { useEffect, useMemo, useRef, useState } from "react";
import { crewTier, settleTiers, type CrewTier, type NeedsYouItem, type TierState } from "../needsYou";
import type { WorkerState } from "../types";

/** 層級要穩定這麼久才換位置：NPC 一個回合內常常忙→閒→忙，不能讓隊員列一直跳。 */
export const TIER_HOLD_MS = 4_000;

/**
 * 隊員列排序用的「已沉澱層級」：升到「需要你」立刻生效；其他變化要維持 holdMs 才生效。
 * frozen=true（例如正在拖曳排序）時完全不動，避免列在手底下換位。
 */
export function useSettledTiers(workers: WorkerState[], needs: ReadonlyMap<string, NeedsYouItem>, frozen: boolean, holdMs = TIER_HOLD_MS): Record<string, CrewTier> {
  const live = useMemo(() => Object.fromEntries(workers.map((worker) => [worker.id, crewTier(worker, needs)])) as Record<string, CrewTier>, [needs, workers]);
  const stateRef = useRef<TierState>({ settled: {}, pending: {} });
  const [tick, setTick] = useState(0);
  const timerRef = useRef<number | null>(null);

  const settled = useMemo(() => {
    if (frozen) return stateRef.current.settled;
    const next = settleTiers(stateRef.current, live, Date.now(), holdMs);
    const unchanged = Object.keys(next.settled).length === Object.keys(stateRef.current.settled).length
      && Object.entries(next.settled).every(([id, tier]) => stateRef.current.settled[id] === tier);
    stateRef.current = { settled: unchanged ? stateRef.current.settled : next.settled, pending: next.pending };
    if (timerRef.current !== null) { window.clearTimeout(timerRef.current); timerRef.current = null; }
    if (next.nextCheckAt !== null && typeof window !== "undefined") {
      timerRef.current = window.setTimeout(() => { timerRef.current = null; setTick((value) => value + 1); }, Math.max(0, next.nextCheckAt - Date.now()) + 16);
    }
    return stateRef.current.settled;
    // tick 只是「時間到了再算一次」的觸發器。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frozen, holdMs, live, tick]);

  useEffect(() => () => { if (timerRef.current !== null) window.clearTimeout(timerRef.current); }, []);
  return settled;
}
