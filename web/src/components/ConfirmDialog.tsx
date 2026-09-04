import { useEffect } from "react";
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
        <button type="button" className={`confirm-dialog__btn confirm-dialog__btn--confirm${tone === "danger" ? " confirm-dialog__btn--danger" : ""}`} onClick={onConfirm} autoFocus={tone !== "danger"}>
          {t("確定")}
        </button>
      </div>
    </Modal>
  );
}
