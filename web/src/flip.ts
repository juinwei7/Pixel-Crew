import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

// SSR（測試用 renderToStaticMarkup）沒有版面可量，退回 useEffect 免得 React 警告。
const useLayoutEffectSafe = typeof document === "undefined" ? useEffect : useLayoutEffect;

/* 第二輪 D 面板的版面過場工具。

   1. FLIP（First, Last, Invert, Play）：清單重排／換欄時，元素先瞬移到新位置，
      再用 Web Animations 從舊位置平移回來。只動獨立的 translate 屬性（不碰
      transform，見 styles/motion.css 原則 1）。
   2. 新鍵追蹤：同一個範疇（例如同一張任務）裡「後來才出現」的項目，才算新的；
      首次渲染、換範疇時看到的都當基準，不播進場。
   3. 分頁亮塊：量出選中分頁的位置，讓一塊亮底平滑滑過去。

   一律尊重 prefers-reduced-motion：FLIP 直接跳過、亮塊不做過渡（CSS 那邊）。 */

export type FlipRect = { left: number; top: number; width: number; height: number };
export type FlipDelta = { dx: number; dy: number };

export const FLIP_KEY_ATTR = "data-flip-key";
export const FLIP_DURATION_MS = 320;
export const FLIP_EASING = "cubic-bezier(0.16, 1, 0.3, 1)";

/** 舊位置相對新位置的位移（Invert 那一步要套的量）。 */
export function flipDelta(first: FlipRect, last: FlipRect): FlipDelta {
  return { dx: first.left - last.left, dy: first.top - last.top };
}

/** 小於半個像素的位移看不出來，播了只是浪費一個合成層。 */
export function isNegligible(delta: FlipDelta, threshold = 0.5): boolean {
  return Math.abs(delta.dx) < threshold && Math.abs(delta.dy) < threshold;
}

/** 依 signature 決定這一輪要不要量「First」：signature 變了才是重排。 */
export function shouldCapture(committed: string | null, next: string): boolean {
  return committed !== null && committed !== next;
}

export function prefersReducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

type Measurable = {
  getBoundingClientRect(): { left: number; top: number; width: number; height: number };
  getAttribute(name: string): string | null;
  animate?: (keyframes: Keyframe[], options: KeyframeAnimationOptions) => Animation;
  getAnimations?: () => Animation[];
};

type Container = { querySelectorAll(selector: string): ArrayLike<unknown> };

function flipElements(container: Container): Measurable[] {
  return Array.from(container.querySelectorAll(`[${FLIP_KEY_ATTR}]`)) as Measurable[];
}

function rectOf(el: Measurable): FlipRect {
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, width: r.width, height: r.height };
}

/** First：記下容器內每個 data-flip-key 元素「現在看起來」的位置（含播到一半的平移）。 */
export function captureRects(container: Container): Map<string, FlipRect> {
  const rects = new Map<string, FlipRect>();
  for (const el of flipElements(container)) {
    const key = el.getAttribute(FLIP_KEY_ATTR);
    if (key) rects.set(key, rectOf(el));
  }
  return rects;
}

const FLIP_ANIMATION_ID = "r2-flip";

/** Last + Invert + Play。回傳實際播了幾個（測試與除錯用）。
 *  新出現的鍵只淡入，不平移——它沒有「從哪來」。 */
export function playFlip(
  container: Container,
  first: Map<string, FlipRect>,
  options: { duration?: number; easing?: string; reduced?: boolean } = {},
): number {
  if (options.reduced ?? prefersReducedMotion()) return 0;
  const duration = options.duration ?? FLIP_DURATION_MS;
  const easing = options.easing ?? FLIP_EASING;
  const elements = flipElements(container);
  // 先停掉上一輪還沒播完的 FLIP，量到的才是真正的新位置（Last）。
  for (const el of elements) {
    for (const animation of el.getAnimations?.() ?? []) {
      if (animation.id === FLIP_ANIMATION_ID) animation.cancel();
    }
  }
  let played = 0;
  for (const el of elements) {
    if (typeof el.animate !== "function") continue;
    const key = el.getAttribute(FLIP_KEY_ATTR);
    if (!key) continue;
    const from = first.get(key);
    if (!from) {
      // 新卡：淡入即可。
      if (first.size > 0) {
        el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: Math.round(duration * 0.75), easing, id: FLIP_ANIMATION_ID });
        played += 1;
      }
      continue;
    }
    const delta = flipDelta(from, rectOf(el));
    if (isNegligible(delta)) continue;
    el.animate(
      [{ translate: `${delta.dx}px ${delta.dy}px` }, { translate: "0px 0px" }],
      { duration, easing, id: FLIP_ANIMATION_ID },
    );
    played += 1;
  }
  return played;
}

/** React 端：signature（例如「欄:卡片鍵…」串起來）一變就做一次 FLIP。
 *  First 在 render 階段量——這時 DOM 還是舊的，等於 class 元件的
 *  getSnapshotBeforeUpdate；捲動、播到一半的動畫都已反映在量到的位置裡。 */
export function useFlip(containerRef: RefObject<HTMLElement | null>, signature: string): void {
  const committed = useRef<string | null>(null);
  const first = useRef<Map<string, FlipRect> | null>(null);
  if (first.current === null && containerRef.current && shouldCapture(committed.current, signature)) {
    first.current = captureRects(containerRef.current);
  }
  useLayoutEffectSafe(() => {
    const container = containerRef.current;
    if (container && first.current) playFlip(container, first.current);
    first.current = null;
    committed.current = signature;
  }, [containerRef, signature]);
}

/* ── 新鍵追蹤 ─────────────────────────────────────────────────────────── */

export type FreshTracker = {
  /** 回傳這個範疇裡「基準之後才出現」的鍵。換範疇時以當下的鍵重設基準。 */
  observe(scope: string, keys: readonly string[]): Set<string>;
};

export function createFreshTracker(): FreshTracker {
  let currentScope: string | null = null;
  let baseline = new Set<string>();
  return {
    observe(scope, keys) {
      if (scope !== currentScope) {
        currentScope = scope;
        baseline = new Set(keys);
        return new Set();
      }
      return new Set(keys.filter((key) => !baseline.has(key)));
    },
  };
}

/** 元件版：新鍵一旦標記就一直標著（動畫只在元素掛上時播一次，留著 class 不會重播）。 */
export function useFreshKeys(scope: string, keys: readonly string[]): Set<string> {
  const tracker = useRef<FreshTracker | null>(null);
  if (!tracker.current) tracker.current = createFreshTracker();
  return tracker.current.observe(scope, keys);
}

/* ── 分頁亮塊 ─────────────────────────────────────────────────────────── */

export type IndicatorBox = { left: number; top: number; width: number; height: number };

/** 選中分頁相對於分頁列的位置（offset 系，與捲動、transform 無關）。 */
export function indicatorBox(active: { offsetLeft: number; offsetTop: number; offsetWidth: number; offsetHeight: number } | null): IndicatorBox | null {
  if (!active || active.offsetWidth === 0) return null;
  return { left: active.offsetLeft, top: active.offsetTop, width: active.offsetWidth, height: active.offsetHeight };
}

/** 量 containerRef 裡符合 selector 的選中分頁；activeKey 變了或容器尺寸變了就重量。
 *  量不到（SSR、隱藏中）回傳 null——呼叫端此時不畫亮塊，維持原本的選中底色。 */
export function useTabIndicator(
  containerRef: RefObject<HTMLElement | null>,
  activeKey: string,
  selector = '[aria-selected="true"]',
): IndicatorBox | null {
  const [box, setBox] = useState<IndicatorBox | null>(null);
  useLayoutEffectSafe(() => {
    const container = containerRef.current;
    if (!container) return;
    const measure = () => {
      const next = indicatorBox(container.querySelector<HTMLElement>(selector));
      setBox((prev) => (
        prev && next && prev.left === next.left && prev.top === next.top && prev.width === next.width && prev.height === next.height
          ? prev
          : next
      ));
    };
    measure();
    if (typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => observer.disconnect();
  }, [containerRef, activeKey, selector]);
  return box;
}

/** 亮塊的 inline style：用 translate 移動、寬高跟著分頁走。 */
export function indicatorStyle(box: IndicatorBox): { translate: string; width: string; height: string } {
  return { translate: `${box.left}px ${box.top}px`, width: `${box.width}px`, height: `${box.height}px` };
}
