import { useEffect, useRef, useState, type CSSProperties } from "react";
import { HOLD_CONFIRM_MS, holdOutcome } from "../uxMotion";
import { Modal } from "./Modal";
import { t } from "../i18n";

export type ConfirmTone = "default" | "danger";

type Props = {
  message: string;
  tone?: ConfirmTone;
  onConfirm(): void;
  onCancel(): void;
};

export function ConfirmDialog({ message, tone = "default", onConfirm, onCancel }: Props) {
  useEffect(() => {
    const captureEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      // A confirmation can be nested inside another Modal. Consume Escape
      // before the underlying modal's window listener sees the same keypress.
      event.stopImmediatePropagation();
      onCancel();
    };
    window.addEventListener("keydown", captureEscape, true);
    return () => window.removeEventListener("keydown", captureEscape, true);
  }, [onCancel]);

  return (
    <Modal label={message} onClose={onCancel} hideClose overlayClassName="warroom-result confirm-dialog" cardClassName="warroom-result__card confirm-dialog__card">
      <p className="confirm-dialog__message">{message}</p>
      <div className="confirm-dialog__actions">
        <button type="button" className="confirm-dialog__btn confirm-dialog__btn--cancel" onClick={onCancel} autoFocus={tone === "danger"}>
          {t("取消")}
        </button>
        {tone === "danger"
          ? <HoldConfirmButton onConfirm={onConfirm} />
          : <button type="button" className="confirm-dialog__btn confirm-dialog__btn--confirm" onClick={onConfirm} autoFocus>
            {t("確定")}
          </button>}
      </div>
    </Modal>
  );
}

/* 危險操作（永久移除 NPC、關閉背景服務…）沒有復原機制，所以改成「按住確定」：
   按住 0.65 秒，按鈕裡一條填充從左走到右，滿了才執行；太早放開＝不算，按鈕
   抖一下並提示要按住。滑鼠、觸控、鍵盤（按住 Enter / 空白鍵）都行。
   輔助科技直接送出的 click（前面沒有任何按下事件）仍然直接確認，不擋路。
   只改前端手勢，送出去的還是同一個 onConfirm。 */
function HoldConfirmButton({ onConfirm }: { onConfirm(): void }) {
  const [holding, setHolding] = useState(false);
  const [nudge, setNudge] = useState(0);
  const startedAt = useRef(0);
  const lastInputAt = useRef(0);
  const timer = useRef<number | null>(null);
  const done = useRef(false);
  useEffect(() => () => { if (timer.current !== null) window.clearTimeout(timer.current); }, []);

  const start = () => {
    lastInputAt.current = performance.now();
    if (timer.current !== null || done.current) return;
    startedAt.current = performance.now();
    setHolding(true);
    timer.current = window.setTimeout(() => {
      timer.current = null;
      done.current = true;
      setHolding(false);
      onConfirm();
    }, HOLD_CONFIRM_MS);
  };
  const release = () => {
    lastInputAt.current = performance.now();
    if (timer.current === null) return;
    window.clearTimeout(timer.current);
    timer.current = null;
    setHolding(false);
    if (holdOutcome(performance.now() - startedAt.current) === "too-short") setNudge((count) => count + 1);
  };

  return (
    <span className="confirm-dialog__hold">
      <button
        type="button"
        className="confirm-dialog__btn confirm-dialog__btn--confirm confirm-dialog__btn--danger confirm-dialog__btn--hold"
        data-holding={holding || undefined}
        data-nudge={nudge ? (nudge % 2 ? "a" : "b") : undefined}
        style={{ "--hold-ms": `${HOLD_CONFIRM_MS}ms` } as CSSProperties}
        aria-describedby="confirm-dialog-hold-hint"
        onPointerDown={(event) => { if (event.button === 0) start(); }}
        onPointerUp={release}
        onPointerLeave={release}
        onPointerCancel={release}
        onKeyDown={(event) => { if ((event.key === "Enter" || event.key === " ") && !event.repeat) { event.preventDefault(); start(); } }}
        onKeyUp={(event) => { if (event.key === "Enter" || event.key === " ") release(); }}
        onClick={() => {
          if (performance.now() - lastInputAt.current > 400 && !done.current) { done.current = true; onConfirm(); }
        }}
      >
        <span className="confirm-dialog__hold-fill" aria-hidden="true" />
        <span className="confirm-dialog__hold-label">{t("按住確定")}</span>
      </button>
      <small id="confirm-dialog-hold-hint" className="confirm-dialog__hold-hint" data-show={nudge ? (nudge % 2 ? "a" : "b") : undefined}>
        {t("按住約 0.6 秒才會執行，避免誤按")}
      </small>
    </span>
  );
}
