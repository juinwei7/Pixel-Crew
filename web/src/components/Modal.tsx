import { useEffect, useRef, type ReactNode } from "react";
import { useFocusTrap } from "../hooks/useFocusTrap";
import { t } from "../i18n";

// 共用 dialog 殼：overlay + 卡片 + 右上關閉鈕 + focus trap + Esc 關閉。
// 三層 class 都會自動加上 ui-modal / ui-modal__card / ui-modal__close，手機版型
// （底部抽屜、安全區、44px 點擊目標、16px 輸入字級）全部由 styles/responsive.css
// 的這三個 selector 統一負責，各 modal 不必再自己寫一套 @media。
// overlayClassName / cardClassName / closeClassName 是「完整」class（不會自動疊加
// warroom-result 系列樣式），沿用 warroom-result 家族的 modal（Ops/Kanban/DayReport/
// 那種）記得自己把 warroom-result / warroom-result__card 也寫進去；有自己一整套
// 卡片樣式的 modal（MCP、Backup…）直接傳自己的 class，避免兩套樣式疊加互相蓋掉。
// eyebrow/title 沒填就不畫內建 header——原本 header 結構更複雜（多說明文字、按鈕）的
// modal，直接把整段原本的 <header> 放進 children 最前面即可。
// hideClose：關閉鈕不是右上角浮動樣式（例如卡在 header 裡排版），或這個狀態下本來就
// 不該有關閉鈕（例如強制設定流程），改由呼叫端自己在 children 裡放關閉鈕/不放。
// 需要「忙碌中不准關」的 modal，把守門邏輯包進傳入的 onClose（Esc 和 × 走同一條路）。
// variant 只影響手機：
//   sheet（預設）＝ 貼底抽屜，適合絕大多數設定/表單類視窗
//   full         ＝ 整頁佔滿（本來在桌面就接近全螢幕的工作台，例如指令中心）
//   center       ＝ 維持置中卡片（不是「視窗」而是擋在前面的關卡，例如登入 gate）
export type ModalVariant = "sheet" | "full" | "center";

type Props = {
  label: string;
  eyebrow?: string;
  title?: string;
  overlayClassName?: string;
  cardClassName?: string;
  closeClassName?: string;
  closeLabel?: string;
  hideClose?: boolean;
  variant?: ModalVariant;
  onClose(): void;
  children: ReactNode;
};

// 純函式，方便測試直接驗證 variant 對應到哪個 class。
export function modalShellClass(variant: ModalVariant = "sheet"): string {
  return variant === "sheet" ? "ui-modal" : `ui-modal ui-modal--${variant}`;
}

export function Modal({
  label,
  eyebrow,
  title,
  overlayClassName = "warroom-result",
  cardClassName = "warroom-result__card",
  closeClassName = "warroom-result__close",
  closeLabel,
  hideClose = false,
  variant = "sheet",
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
    <div className={`${modalShellClass(variant)} ${overlayClassName}`} role="dialog" aria-modal="true" aria-label={label}>
      <div className={`ui-modal__card ${cardClassName}`} ref={dialogRef}>
        {!hideClose && <button type="button" className={`ui-modal__close ${closeClassName}`} onClick={onClose} aria-label={closeLabel ?? t("關閉視窗")}>×</button>}
        {(eyebrow || title) && <header>{eyebrow && <span>{eyebrow}</span>}{title && <h2>{title}</h2>}</header>}
        {children}
      </div>
    </div>
  );
}
