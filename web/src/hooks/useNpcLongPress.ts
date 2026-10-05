import { useEffect, useState, type RefObject } from "react";

// 觸控長按 NPC＝右鍵：手機沒有右鍵，徑向選單原本根本叫不出來。
//
// 場景（game/scene.ts）只認 Pixi 的 rightclick，這一層不能改它，所以長按成立時
// 在同一個點對畫布補送一組「右鍵按下＋放開」的 PointerEvent，讓 Pixi 照原本的
// 路徑把選單打開——NPC 命中判定、選單朝哪邊開，全部沿用場景自己的邏輯。
// 按住期間在手指下畫一圈逐漸填滿的環（styles/motion.css 的 .pc-longpress），
// 手指移動超過門檻（在拖曳畫面）就取消。

export const LONG_PRESS_MS = 480;
const MOVE_TOLERANCE_PX = 10;
// 補送事件用的假 pointerId，避開真實觸控（從 1 起跳的小整數）。
const SYNTHETIC_POINTER_ID = 7331;

export type LongPressRing = { x: number; y: number; key: number } | null;

export function useNpcLongPress(hostRef: RefObject<HTMLElement>, enabled: boolean): LongPressRing {
  const [ring, setRing] = useState<LongPressRing>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !enabled) return;
    let timer: number | null = null;
    let start: { x: number; y: number; id: number; canvas: HTMLCanvasElement } | null = null;

    const cancel = () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
      start = null;
      setRing(null);
    };

    const fire = () => {
      timer = null;
      const origin = start;
      start = null;
      setRing(null);
      if (!origin) return;
      const init: PointerEventInit = {
        bubbles: true, cancelable: true, composed: true,
        clientX: origin.x, clientY: origin.y, screenX: origin.x, screenY: origin.y,
        pointerId: SYNTHETIC_POINTER_ID, pointerType: "mouse", isPrimary: true,
        button: 2, buttons: 2,
      };
      // 中間那一下「往旁邊挪 8px 再回來」是刻意的：場景把超過 6px 的按壓視為拖曳，
      // 拖曳就不會觸發「點選 NPC」（那會打開任務日誌、聚焦輸入框——手機上等於
      // 彈出整片抽屜和鍵盤把剛開的選單蓋掉）。放開時回到原點，右鍵仍落在同一位
      // NPC 身上，rightclick 照常成立。
      origin.canvas.dispatchEvent(new PointerEvent("pointerdown", init));
      origin.canvas.dispatchEvent(new PointerEvent("pointermove", { ...init, clientX: origin.x + 8, screenX: origin.x + 8 }));
      origin.canvas.dispatchEvent(new PointerEvent("pointermove", init));
      origin.canvas.dispatchEvent(new PointerEvent("pointerup", { ...init, buttons: 0 }));
      try { navigator.vibrate?.(8); } catch { /* 不支援震動就算了 */ }
    };

    const down = (event: PointerEvent) => {
      // 滑鼠（含補送的右鍵）、第二根手指（雙指縮放）都會取消進行中的長按。
      if (event.pointerType !== "touch" || !event.isPrimary) { cancel(); return; }
      if (!(event.target instanceof HTMLCanvasElement)) return;
      cancel();
      start = { x: event.clientX, y: event.clientY, id: event.pointerId, canvas: event.target };
      setRing({ x: event.clientX, y: event.clientY, key: Date.now() });
      timer = window.setTimeout(fire, LONG_PRESS_MS);
    };
    const move = (event: PointerEvent) => {
      if (!start || event.pointerId !== start.id) return;
      if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > MOVE_TOLERANCE_PX) cancel();
    };
    const end = (event: PointerEvent) => {
      if (start && event.pointerId === start.id) cancel();
    };

    host.addEventListener("pointerdown", down, true);
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", end, true);
    window.addEventListener("pointercancel", end, true);
    return () => {
      cancel();
      host.removeEventListener("pointerdown", down, true);
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", end, true);
      window.removeEventListener("pointercancel", end, true);
    };
  }, [enabled, hostRef]);

  return ring;
}
