/* 手機版「左右滑動換下一個」的共用判定。

   目前有兩個地方用：黑窗一次只顯示一個 pane（見 styles 的
   .black-window:not(--active)），頂欄的工作模式在手機也只顯示目前那一個。
   兩者的水平方向本來就沒有別的意思——終端機只會垂直捲動（scrollback），
   頂欄也不會水平捲。這裡把「這一下算不算換頁」的判斷抽成純函式：元件只
   負責收起訖座標，門檻與方向的邏輯可以單獨測。

   門檻是為了不要誤判這三種操作：
   - 捲動 scrollback：垂直位移大 → 要求水平位移至少是垂直的兩倍
   - 在終端機裡選字：那是慢動作 → 限制在 600ms 內完成
   - 手指只是輕碰或微抖：要求一段明確的距離 */

/** 整頁大的目標（黑窗 pane）：約 0.5cm 以上才算數。 */
export const SWIPE_MIN_DISTANCE = 72;
/** 頂欄那顆模式鈕只有 100px 出頭，手指起點就在它身上，門檻要小一點才跟得上手。 */
export const SWIPE_MIN_DISTANCE_CHIP = 40;
export const SWIPE_DOMINANCE = 2;
export const SWIPE_MAX_MS = 600;

export type SwipeGesture = {
  dx: number;
  dy: number;
  elapsedMs: number;
};

/** -1 = 往前一個（右滑）、1 = 往後一個（左滑）、0 = 不算換頁。 */
export function swipeStep(gesture: SwipeGesture, minDistance = SWIPE_MIN_DISTANCE): -1 | 0 | 1 {
  const { dx, dy, elapsedMs } = gesture;
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || !Number.isFinite(elapsedMs)) return 0;
  if (elapsedMs > SWIPE_MAX_MS) return 0;
  if (Math.abs(dx) < minDistance) return 0;
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
