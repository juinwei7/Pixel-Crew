import { useEffect, useState } from "react";

// 數字改變時舊值往上滑走、新值從下面滑進來（變小時方向相反）。樣式在
// styles/motion.css 的 .pc-roll；reduced-motion 下退成交叉淡入。
// 只有「真的變了」才動：第一次 render 原地出現，不會一進頁面就整排在滾。

const ROLL_OUT_MS = 200;

type RollState = { current: number; previous: number | null; direction: "up" | "down"; key: number };

export function RollingNumber({ value }: { value: number }) {
  const [state, setState] = useState<RollState>({ current: value, previous: null, direction: "up", key: 0 });

  useEffect(() => {
    setState((prev) => prev.current === value
      ? prev
      : { current: value, previous: prev.current, direction: value > prev.current ? "up" : "down", key: prev.key + 1 });
  }, [value]);

  useEffect(() => {
    if (state.previous === null) return;
    const timer = window.setTimeout(() => setState((prev) => ({ ...prev, previous: null })), ROLL_OUT_MS);
    return () => window.clearTimeout(timer);
  }, [state.key, state.previous]);

  return (
    // data-bump：數字一變，整顆徽章彈一下（a/b 交替才會連續重播，styles/motion-fx.css）。
    <span className={`pc-roll${state.direction === "down" ? " pc-roll--down" : ""}`} data-bump={state.key > 0 ? (state.key % 2 ? "a" : "b") : undefined}>
      {state.previous !== null && <span key={`out-${state.key}`} className="pc-roll__out" aria-hidden="true">{state.previous}</span>}
      <span key={`in-${state.key}`} className={state.key > 0 ? "pc-roll__in" : undefined}>{state.current}</span>
    </span>
  );
}
