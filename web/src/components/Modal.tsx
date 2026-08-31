import { useEffect, useRef, type ReactNode } from "react";
import { useFocusTrap } from "../hooks/useFocusTrap";
import { t } from "../i18n";

// 共用 dialog 殼：overlay + 卡片 + 右上關閉鈕 + focus trap + Esc 關閉。
// overlayClassName / cardClassName / closeClassName 是「完整」class（不會自動疊加
// warroom-result 系列樣式），沿用 warroom-result 家族的 modal（Ops/Kanban/DayReport/
// 那種）記得自己把 warroom-result / warroom-result__card 也寫進去；有自己一整套
// 卡片樣式的 modal（MCP、Backup…）直接傳自己的 class，避免兩套樣式疊加互相蓋掉。
// eyebrow/title 沒填就不畫內建 header——原本 header 結構更複雜（多說明文字、按鈕）的
// modal，直接把整段原本的 <header> 放進 children 最前面即可。
// hideClose：關閉鈕不是右上角浮動樣式（例如卡在 header 裡排版），或這個狀態下本來就
// 不該有關閉鈕（例如強制設定流程），改由呼叫端自己在 children 裡放關閉鈕/不放。
// 需要「忙碌中不准關」的 modal，把守門邏輯包進傳入的 onClose（Esc 和 × 走同一條路）。
type Props = {
  label: string;
  eyebrow?: string;
  title?: string;
  overlayClassName?: string;
  cardClassName?: string;
  closeClassName?: string;
  closeLabel?: string;
  hideClose?: boolean;
  onClose(): void;
  children: ReactNode;
};

export function Modal({
  label,
  eyebrow,
  title,
  overlayClassName = "warroom-result",
  cardClassName = "warroom-result__card",
  closeClassName = "warroom-result__close",
  closeLabel,
  hideClose = false,
  onClose,
  children,
}: Props) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className={overlayClassName} role="dialog" aria-modal="true" aria-label={label}>
      <div className={cardClassName} ref={dialogRef}>
        {!hideClose && <button type="button" className={closeClassName} onClick={onClose} aria-label={closeLabel ?? t("關閉視窗")}>×</button>}
        {(eyebrow || title) && <header>{eyebrow && <span>{eyebrow}</span>}{title && <h2>{title}</h2>}</header>}
        {children}
      </div>
    </div>
  );
}
