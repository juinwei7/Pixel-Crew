import { t } from "../i18n";

type Props = {
  workerName: string;
  currentModelLabel: string;
  targetModelLabel: string;
  focusMode?: boolean;
  submitting?: boolean;
  onContinue(): void;
  onFresh(): void;
  onCancel(): void;
};

export function ModelSwitchCard({
  workerName,
  currentModelLabel,
  targetModelLabel,
  focusMode = false,
  submitting = false,
  onContinue,
  onFresh,
  onCancel,
}: Props) {
  return (
    <section className={`model-switch-card ${focusMode ? "model-switch-card--focus" : ""}`} aria-label={t("模型切換選擇")} aria-live="polite">
      <div className="model-switch-card__icon" aria-hidden="true">⇄</div>
      <div className="model-switch-card__body">
        <span className="model-switch-card__eyebrow">BOSS · MODEL SWITCH</span>
        <strong>{t("{worker} 要切換到 {target}", { worker: workerName, target: targetModelLabel })}</strong>
        <p>{t("目前是 {current}。要沿用現有對話脈絡，或丟棄模型工作階段、直接重新開始？NPC 設定與這裡的歷史紀錄都會保留。", { current: currentModelLabel })}</p>
        <div className="model-switch-card__actions">
          <button type="button" disabled={submitting} onClick={onContinue}>{t("沿用目前工作階段")}</button>
          <button type="button" className="model-switch-card__fresh" disabled={submitting} onClick={onFresh}>{t("不交接，開新工作階段")}</button>
          <button type="button" className="model-switch-card__cancel" disabled={submitting} onClick={onCancel}>{t("取消")}</button>
        </div>
      </div>
    </section>
  );
}
