// 本機服務連線狀態 → 介面要演哪一段：
//   online：什麼都不畫
//   down  ：斷線超過 downDelayMs 才算真的斷（單次閃斷不閃畫面）
//   back  ：從 down 恢復後亮一下「已回來」，backHoldMs 後回到 online
// 純邏輯、計時器可注入，方便測試；React 那層只負責把 phase 畫出來。
// 只有「真的進入 down」與「從 down 回來」才通知 onFx——場景據此熄燈／開燈。

export type ConnectionPhase = "online" | "down" | "back";

export type ConnectionTimers = {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
  now(): number;
};

export type ConnectionWatchOptions = {
  /** 斷線要持續多久才算數（預設 1500ms）。 */
  downDelayMs?: number;
  /** 「已回來」停留多久（預設 1600ms）。 */
  backHoldMs?: number;
  timers?: ConnectionTimers;
  /** since＝實際斷線的時間點（不是 debounce 結束時），用來算已等待秒數。 */
  onPhase(phase: ConnectionPhase, since: number): void;
  onFx?(state: "down" | "up"): void;
};

export const CONNECTION_DOWN_DELAY_MS = 1500;
export const CONNECTION_BACK_HOLD_MS = 1600;

const realTimers: ConnectionTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

export function createConnectionWatch(options: ConnectionWatchOptions) {
  const downDelay = options.downDelayMs ?? CONNECTION_DOWN_DELAY_MS;
  const backHold = options.backHoldMs ?? CONNECTION_BACK_HOLD_MS;
  const timers = options.timers ?? realTimers;
  let phase: ConnectionPhase = "online";
  let ready: boolean | null = null;
  let droppedAt = 0;
  let downTimer: unknown = null;
  let backTimer: unknown = null;

  function go(next: ConnectionPhase, since: number) {
    if (phase === next) return;
    phase = next;
    options.onPhase(next, since);
  }
  function clearDown() {
    if (downTimer !== null) timers.clear(downTimer);
    downTimer = null;
  }
  function clearBack() {
    if (backTimer !== null) timers.clear(backTimer);
    backTimer = null;
  }

  return {
    get phase() { return phase; },
    update(nextReady: boolean) {
      if (ready === nextReady) return;
      ready = nextReady;
      if (!nextReady) {
        droppedAt = timers.now();
        if (phase === "back") {
          // 剛說完「已回來」又掉：畫面上的提示還在，直接接回 down，不再等。
          clearBack();
          go("down", droppedAt);
          options.onFx?.("down");
          return;
        }
        clearDown();
        downTimer = timers.set(() => {
          downTimer = null;
          go("down", droppedAt);
          options.onFx?.("down");
        }, downDelay);
        return;
      }
      if (downTimer !== null) {
        // 閃斷：還沒到門檻就接回來了，什麼都不演。
        clearDown();
        return;
      }
      if (phase === "down") {
        go("back", timers.now());
        options.onFx?.("up");
        clearBack();
        backTimer = timers.set(() => {
          backTimer = null;
          go("online", timers.now());
        }, backHold);
      }
    },
    dispose() {
      clearDown();
      clearBack();
    },
  };
}
