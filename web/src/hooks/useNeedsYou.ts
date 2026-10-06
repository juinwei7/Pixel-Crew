import { useEffect, useMemo, useRef, useState } from "react";
import {
  collectNeedsYou,
  needsYouByWorker,
  needsYouSummary,
  STUCK_AFTER_MS,
  stuckWorkers,
  trackProgress,
  type NeedsYouItem,
  type ProgressMap,
} from "../needsYou";
import type { WorkerState } from "../types";

/** 卡住偵測的時鐘：有人在跑時每 30 秒重算一次，沒人在跑就不跑計時器。 */
const STUCK_TICK_MS = 30_000;

export type NeedsYouState = {
  items: NeedsYouItem[];
  byWorker: Map<string, NeedsYouItem>;
  summary: ReturnType<typeof needsYouSummary>;
  /** 卡住的 NPC → 已停滯 ms（含在 items 裡的 stuck 項目，另外索引方便隊員列查）。 */
  stuck: Map<string, number>;
};

/**
 * App 層的「需要你」狀態：包住 needsYou.ts 的純函式，補上兩個需要記憶的東西——
 *  1. 看過了沒：目前正在看的 NPC（viewing=true）最新回合記成已看，失敗／提問就不再算。
 *  2. 多久沒進展：每位 NPC 的進度簽章與最後變化時間。
 */
export function useNeedsYou(workers: WorkerState[], activeId: string | null, viewing: boolean): NeedsYouState {
  const [seenTurnKeys, setSeenTurnKeys] = useState<Record<string, string | null>>({});
  const active = activeId ? workers.find((worker) => worker.id === activeId) : undefined;
  const activeLastKey = active?.turns[active.turns.length - 1]?.key ?? null;
  const activeBusy = Boolean(active?.busy);
  useEffect(() => {
    if (!viewing || !activeId || !activeLastKey || activeBusy) return;
    setSeenTurnKeys((current) => (current[activeId] === activeLastKey ? current : { ...current, [activeId]: activeLastKey }));
  }, [activeBusy, activeId, activeLastKey, viewing]);

  const progressRef = useRef<ProgressMap>({});
  const progress = useMemo(() => {
    progressRef.current = trackProgress(progressRef.current, workers, Date.now());
    return progressRef.current;
  }, [workers]);

  const anyBusy = workers.some((worker) => worker.busy);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!anyBusy) return;
    const timer = window.setInterval(() => setNow(Date.now()), STUCK_TICK_MS);
    return () => window.clearInterval(timer);
  }, [anyBusy]);
  // 計時器每 30 秒才走一格；workers 變化時用當下時間，避免剛變化就用舊時鐘。
  const clock = Math.max(now, ...Object.values(progress).map((entry) => entry.at));

  return useMemo(() => {
    const items = collectNeedsYou(workers, { seenTurnKeys, progress, now: clock, stuckAfterMs: STUCK_AFTER_MS });
    return {
      items,
      byWorker: needsYouByWorker(items),
      summary: needsYouSummary(items),
      stuck: stuckWorkers(workers, progress, clock, STUCK_AFTER_MS),
    };
  }, [clock, progress, seenTurnKeys, workers]);
}
