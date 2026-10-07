import { useEffect, useRef, useState, type CSSProperties } from "react";
import { t } from "../i18n";

// 複製鈕：按下去字往上收走、勾勾畫出來停 1.4 秒，再把「複製」浮回來
// （styles/motion-ui.css 的 .pc-copy）。按鈕寬度鎖住，換字時不會跳動。
// 複製失敗（沒有剪貼簿權限）就安靜不動，跟原本一樣。

export const COPY_DONE_MS = 1400;

type Props = {
  text: string;
  label?: string;
  style?: CSSProperties;
  className?: string;
  onCopied?(): void;
};

export function CopyButton({ text, label, style, className, onCopied }: Props) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(() => () => { if (timer.current !== null) window.clearTimeout(timer.current); }, []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      return;
    }
    if (timer.current !== null) window.clearTimeout(timer.current);
    setCopied(true);
    onCopied?.();
    timer.current = window.setTimeout(() => setCopied(false), COPY_DONE_MS);
  }

  return (
    <button type="button" className={`pc-copy${className ? ` ${className}` : ""}`} data-copied={copied || undefined} style={style} onClick={() => void copy()} aria-live="polite">
      <span className="pc-copy__label">{label ?? t("複製")}</span>
      <span className="pc-copy__done" aria-hidden={!copied}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
        {t("已複製")}
      </span>
    </button>
  );
}
