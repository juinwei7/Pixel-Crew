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
    <section className={`model-switch-card ${focusMode ? "model-switch-card--focus" : ""}`} aria-label="模型切換選擇" aria-live="polite">
      <div className="model-switch-card__icon" aria-hidden="true">⇄</div>
      <div className="model-switch-card__body">
        <span className="model-switch-card__eyebrow">BOSS · MODEL SWITCH</span>
        <strong>{workerName} 要切換到 {targetModelLabel}</strong>
        <p>目前是 {currentModelLabel}。要沿用現有對話脈絡，或丟棄模型工作階段、直接重新開始？NPC 設定與這裡的歷史紀錄都會保留。</p>
        <div className="model-switch-card__actions">
          <button type="button" disabled={submitting} onClick={onContinue}>沿用目前工作階段</button>
          <button type="button" className="model-switch-card__fresh" disabled={submitting} onClick={onFresh}>不交接，開新工作階段</button>
          <button type="button" className="model-switch-card__cancel" disabled={submitting} onClick={onCancel}>取消</button>
        </div>
      </div>
    </section>
  );
}
