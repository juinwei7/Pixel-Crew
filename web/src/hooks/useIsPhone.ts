import { useEffect, useState } from "react";

/* 手機斷點的 JS 這一半。門檻跟 styles/responsive.css 的 phone 斷點是同一個
   數字，由 web/test/responsiveTokens.test.ts 一起把關。

   只有「控制項要換一個 DOM 位置」（例如從工具列搬進 ⋯ 選單，而元件本身有
   狀態、不能同時存在兩份）才用這個 hook。純版型一律留在 CSS——用 JS 做
   版型會在轉向／拖視窗時閃一下，而且 SSR 那一輪拿不到正確答案。 */
export const PHONE_MAX_WIDTH = 600;

const PHONE_QUERY = `(max-width: ${PHONE_MAX_WIDTH}px)`;

/** 目前是不是手機寬度。沒有 window/matchMedia（測試的 renderToStaticMarkup、
    SSR）時一律當成桌面，這樣靜態輸出就是完整版的工具列。 */
export function matchesPhoneWidth(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia(PHONE_QUERY).matches;
}

export function useIsPhone(): boolean {
  const [isPhone, setIsPhone] = useState(matchesPhoneWidth);
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(PHONE_QUERY);
    const sync = () => setIsPhone(query.matches);
    // 第一次掛載時再同步一次：useState 的初值是在 hydration 前算的。
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);
  return isPhone;
}
