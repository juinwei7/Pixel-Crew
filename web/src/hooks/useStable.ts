import { useCallback, useRef } from "react";

/* 減少重渲染用的兩個小工具：
   - useStableBy：值的「內容簽章」沒變就回傳上一份參照，讓 React.memo 子元件跳過重渲染。
   - useEventCallbacks：一組 handler 換成參照永遠不變的包裝，呼叫時轉給最新版本。
     App 傳給 TopBar／WorkerTabs 的 callback 多半是 inline lambda，每次 render 都是新函式，
     會打穿 memo；包一層之後參照穩定、行為仍是最新的。 */

export function useStableBy<T>(value: T, key: string): T {
  const ref = useRef<{ key: string; value: T } | null>(null);
  if (!ref.current || ref.current.key !== key) ref.current = { key, value };
  return ref.current.value;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFn = (...args: any[]) => any;

export function useEventCallbacks<T extends Record<string, AnyFn | undefined>>(handlers: T): T {
  const latest = useRef(handlers);
  latest.current = handlers;
  const stable = useRef<Partial<Record<keyof T, AnyFn>>>({});
  const out = {} as Record<keyof T, AnyFn | undefined>;
  for (const name of Object.keys(handlers) as Array<keyof T>) {
    if (handlers[name] === undefined) { out[name] = undefined; continue; }
    stable.current[name] ??= (...args: unknown[]) => latest.current[name]?.(...args);
    out[name] = stable.current[name];
  }
  // 同一組 key 的物件也要穩定，方便整包 spread 進 props 時不產生新參照差異。
  const keyList = (Object.keys(out) as string[]).filter((name) => out[name as keyof T] !== undefined).join("|");
  const memo = useRef<{ keys: string; value: T } | null>(null);
  if (!memo.current || memo.current.keys !== keyList) memo.current = { keys: keyList, value: out as T };
  return memo.current.value;
}

/** 單一穩定 callback（等同 useEvent RFC）。 */
export function useEventCallback<A extends unknown[], R>(handler: (...args: A) => R): (...args: A) => R {
  const latest = useRef(handler);
  latest.current = handler;
  return useCallback((...args: A) => latest.current(...args), []);
}
