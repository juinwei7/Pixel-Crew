import { useEffect, useRef } from "react";
import { apiRequest } from "../api";
import type { WorkerState } from "../types";

// 成品匣「出現新檔」的偵測：不另外開輪詢。成品只會在某位 NPC 做完一回合時
// 出現，所以只在「有人從忙碌變回閒置」時，稍等一下再讀一次 GET /api/outbox，
// 跟上一次看到的檔名比對。第一次讀到的清單當基準，不算新成品。
// 只讀不寫：整段只有 GET。

type OutboxItem = { workerId: string; name: string; mtime: number };
export type NewDeliverable = { workerId: string | null; name: string };

// 回合結束到檔案寫完之間可能還有一點延遲（最後一個工具剛回報完）。
const SETTLE_MS = 1500;

/** 純函式：從新清單挑出「上次沒看過」的檔案，並推回是哪位 NPC 做的。
 *  outbox 以工作區為單位，server 回的 workerId 只是該資料夾的第一位擁有者；
 *  如果剛做完的 NPC 跟它同一個工作區，就算在剛做完的那位頭上。 */
export function diffDeliverables(
  known: Set<string>,
  items: OutboxItem[],
  justFinished: string[],
  workspaceOf: (workerId: string) => string | undefined,
): NewDeliverable[] {
  const fresh: NewDeliverable[] = [];
  for (const item of items) {
    const key = `${item.workerId}/${item.name}`;
    if (known.has(key)) continue;
    const workspace = workspaceOf(item.workerId);
    const finisher = justFinished.find((id) => workspace !== undefined && workspaceOf(id) === workspace);
    fresh.push({ workerId: finisher ?? item.workerId ?? null, name: item.name });
  }
  return fresh;
}

/** 成品檔的下載路徑：outbox 以資料夾擁有者（server 回的 workerId）定位，不是剛做完的那位。 */
export function deliverableHref(ownerWorkerId: string, name: string): string {
  return `/api/outbox/file?worker=${encodeURIComponent(ownerWorkerId)}&name=${encodeURIComponent(name)}`;
}

/** onNew 的第二個參數：與 items 一一對應的資料夾擁有者 id（組下載連結用）。 */
export function useDeliverableWatch(workers: WorkerState[], onNew: (items: NewDeliverable[], owners: string[]) => void): void {
  const knownRef = useRef<Set<string> | null>(null);
  const busyRef = useRef<Set<string>>(new Set());
  const finishedRef = useRef<string[]>([]);
  const timerRef = useRef<number | null>(null);
  const workersRef = useRef(workers);
  workersRef.current = workers;
  const onNewRef = useRef(onNew);
  onNewRef.current = onNew;

  async function read(): Promise<OutboxItem[] | null> {
    try {
      return (await apiRequest<{ items: OutboxItem[] }>("/api/outbox")).items;
    } catch {
      return null; // 讀不到就等下一次有人收工再說
    }
  }

  useEffect(() => {
    let cancelled = false;
    void read().then((items) => {
      if (cancelled || !items) return;
      knownRef.current = new Set(items.map((item) => `${item.workerId}/${item.name}`));
    });
    return () => {
      cancelled = true;
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, []);

  useEffect(() => {
    const busyNow = new Set(workers.filter((worker) => worker.busy).map((worker) => worker.id));
    const finished = [...busyRef.current].filter((id) => !busyNow.has(id));
    busyRef.current = busyNow;
    if (finished.length === 0 || !knownRef.current) return;
    finishedRef.current = [...new Set([...finishedRef.current, ...finished])];
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      const justFinished = finishedRef.current;
      finishedRef.current = [];
      void read().then((items) => {
        const known = knownRef.current;
        if (!items || !known) return;
        const workspaceOf = (id: string) => workersRef.current.find((worker) => worker.id === id)?.workspacePath;
        const fresh = diffDeliverables(known, items, justFinished, workspaceOf);
        // diffDeliverables 依序為每個未知檔案產生一筆，所以同樣的過濾就能對齊擁有者。
        const owners = items.filter((item) => !known.has(`${item.workerId}/${item.name}`)).map((item) => item.workerId);
        knownRef.current = new Set(items.map((item) => `${item.workerId}/${item.name}`));
        if (fresh.length > 0) onNewRef.current(fresh, owners);
      });
    }, SETTLE_MS);
  }, [workers]);
}
