/* 黑窗手機版的左右滑動換 pane。

   手機一次只顯示一個 pane（見 styles 的 .black-window:not(--active)），所以
   水平方向本來就沒有別的意思——終端機只會垂直捲動（scrollback），畫面也
   不會水平捲。這裡把「這一下算不算換頁」的判斷抽成純函式：元件只負責收
   起訖座標，門檻與方向的邏輯可以單獨測。

   門檻是為了不要誤判這三種操作：
   - 捲動 scrollback：垂直位移大 → 要求水平位移至少是垂直的兩倍
   - 在終端機裡選字：那是慢動作 → 限制在 600ms 內完成
   - 手指只是輕碰或微抖：要求至少 72px（約 0.5cm 以上的明確滑動） */

export const SWIPE_MIN_DISTANCE = 72;
export const SWIPE_DOMINANCE = 2;
export const SWIPE_MAX_MS = 600;

export type SwipeGesture = {
  dx: number;
  dy: number;
  elapsedMs: number;
};

/** -1 = 往前一個 pane（右滑）、1 = 往後一個（左滑）、0 = 不算換頁。 */
export function swipeStep(gesture: SwipeGesture): -1 | 0 | 1 {
  const { dx, dy, elapsedMs } = gesture;
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || !Number.isFinite(elapsedMs)) return 0;
  if (elapsedMs > SWIPE_MAX_MS) return 0;
  if (Math.abs(dx) < SWIPE_MIN_DISTANCE) return 0;
  if (Math.abs(dx) < Math.abs(dy) * SWIPE_DOMINANCE) return 0;
  return dx < 0 ? 1 : -1;
}

/** 停在兩端不繞回去：走到最後一個再往後滑，維持原樣比突然跳回第一個好懂。 */
export function paneAfterSwipe(currentIndex: number, count: number, step: -1 | 0 | 1): number {
  if (step === 0 || count <= 1) return currentIndex;
  if (currentIndex < 0) return currentIndex;
  const next = currentIndex + step;
  if (next < 0 || next >= count) return currentIndex;
  return next;
}
