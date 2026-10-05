import { useEffect, useState } from "react";

export type Toast = { id: string; message: string; tone?: "ok" | "error" | "info" };

// 退場動畫時長（styles/motion.css 的 .toast[data-leaving] 用 var(--dur-1)）。
const TOAST_EXIT_MS = 130;

type Rendered = { toast: Toast; leaving: boolean };

/** 父層的 toasts 一移除就消失會很突兀；這裡多留一份「正在離場」的清單，
 *  原地播完上收淡出再真的拿掉。純函式方便測試：沿用舊順序、移除的標成
 *  leaving、新的接在後面。 */
export function mergeToastList(previous: Rendered[], toasts: Toast[]): Rendered[] {
  const ids = new Set(toasts.map((toast) => toast.id));
  const kept = previous.map((entry) => ids.has(entry.toast.id)
    ? { toast: toasts.find((toast) => toast.id === entry.toast.id)!, leaving: false }
    : { ...entry, leaving: true });
  const known = new Set(previous.map((entry) => entry.toast.id));
  return [...kept, ...toasts.filter((toast) => !known.has(toast.id)).map((toast) => ({ toast, leaving: false }))];
}

export function ToastRegion({ toasts, onDismiss }: { toasts: Toast[]; onDismiss(id: string): void }) {
  const [rendered, setRendered] = useState<Rendered[]>(() => toasts.map((toast) => ({ toast, leaving: false })));

  useEffect(() => {
    if (toasts.length === 0) return;
    const timers = toasts.map((toast) => window.setTimeout(() => onDismiss(toast.id), 3200));
    return () => timers.forEach(window.clearTimeout);
  }, [toasts, onDismiss]);

  useEffect(() => {
    setRendered((previous) => mergeToastList(previous, toasts));
    const timer = window.setTimeout(() => setRendered((previous) => previous.filter((entry) => !entry.leaving)), TOAST_EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [toasts]);

  return (
    <div className="toast-region" aria-live="polite" aria-atomic="false">
      {rendered.map(({ toast, leaving }) => (
        <button key={toast.id} type="button" className={`toast toast--${toast.tone ?? "info"}`} data-leaving={leaving ? "true" : undefined} onClick={() => onDismiss(toast.id)}>
          <i />{toast.message}<span>×</span>
        </button>
      ))}
    </div>
  );
}
