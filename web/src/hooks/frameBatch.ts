// WS 訊息批次化：同一個畫面 frame 內收到的多則訊息，攢起來在下一個
// requestAnimationFrame 一次套用。React 18 會把同一個 callback 裡的所有 setState
// 合併成一次 render，所以串流時（一秒幾十則 event）從「每則一次 render」降到「每 frame 一次」。
//
// 分頁在背景時瀏覽器會暫停 rAF；同時排一個 setTimeout 當保底，兩者誰先到誰 flush，
// 確保背景分頁的狀態（通知、未讀）不會無限期卡住。

export type FrameScheduler = {
  requestFrame(callback: () => void): unknown;
  cancelFrame(handle: unknown): void;
  setTimer(callback: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
};

export type FrameBatcher<T> = {
  push(item: T): void;
  /** 立刻套用已攢的訊息（例如連線關閉前）。 */
  flush(): void;
  /** 丟掉尚未套用的訊息並取消排程（unmount 用）。 */
  cancel(): void;
  readonly pending: number;
};

export const FRAME_FALLBACK_MS = 64;

function browserScheduler(): FrameScheduler {
  const hasRaf = typeof requestAnimationFrame === "function";
  return {
    requestFrame: (callback) => (hasRaf ? requestAnimationFrame(callback) : setTimeout(callback, 16)),
    cancelFrame: (handle) => (hasRaf ? cancelAnimationFrame(handle as number) : clearTimeout(handle as ReturnType<typeof setTimeout>)),
    setTimer: (callback, ms) => setTimeout(callback, ms),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
}

export function createFrameBatcher<T>(apply: (items: T[]) => void, scheduler: FrameScheduler = browserScheduler(), fallbackMs = FRAME_FALLBACK_MS): FrameBatcher<T> {
  let queue: T[] = [];
  let frame: unknown = null;
  let timer: unknown = null;

  const clear = () => {
    if (frame !== null) scheduler.cancelFrame(frame);
    if (timer !== null) scheduler.clearTimer(timer);
    frame = null;
    timer = null;
  };

  const flush = () => {
    clear();
    if (queue.length === 0) return;
    const items = queue;
    queue = [];
    apply(items);
  };

  return {
    push(item: T) {
      queue.push(item);
      if (frame !== null || timer !== null) return;
      frame = scheduler.requestFrame(flush);
      timer = scheduler.setTimer(flush, fallbackMs);
    },
    flush,
    cancel() {
      clear();
      queue = [];
    },
    get pending() {
      return queue.length;
    },
  };
}
