import { useEffect } from "react";

export type Toast = { id: string; message: string; tone?: "ok" | "error" | "info" };

export function ToastRegion({ toasts, onDismiss }: { toasts: Toast[]; onDismiss(id: string): void }) {
  useEffect(() => {
    if (toasts.length === 0) return;
    const timers = toasts.map((toast) => window.setTimeout(() => onDismiss(toast.id), 3200));
    return () => timers.forEach(window.clearTimeout);
  }, [toasts, onDismiss]);

  return (
    <div className="toast-region" aria-live="polite" aria-atomic="false">
      {toasts.map((toast) => (
        <button key={toast.id} type="button" className={`toast toast--${toast.tone ?? "info"}`} onClick={() => onDismiss(toast.id)}>
          <i />{toast.message}<span>×</span>
        </button>
      ))}
    </div>
  );
}
