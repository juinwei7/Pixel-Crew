/* 畫面更新率：沒人在忙、使用者也沒在操作時降到 30fps，省 GPU／電；
   有人在忙、鏡頭在動、或剛有滑鼠／觸控／滾輪操作時回到 60fps（高刷新率螢幕也封頂 60，
   不跟著 144Hz 空轉）。分頁縮小或被切走時瀏覽器本來就會停掉 rAF，不必另外處理。 */

export const ACTIVE_FPS = 60;
export const IDLE_FPS = 30;
/** 最後一次操作後維持 60fps 的時間：拖曳／縮放放手後的收尾還順。 */
export const INPUT_HOLD_MS = 2_500;

export function targetFps(state: { anyBusy: boolean; cameraMoving: boolean; sinceInputMs: number }): number {
  if (state.anyBusy || state.cameraMoving || state.sinceInputMs < INPUT_HOLD_MS) return ACTIVE_FPS;
  return IDLE_FPS;
}
