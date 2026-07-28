import { useEffect, useRef, useState } from "react";
import type { PreparedHandoff, ProviderId, WorkerState } from "../types";
import { useFocusTrap } from "../hooks/useFocusTrap";

type Props = {
  worker: WorkerState;
  toProvider: ProviderId;
  onPrepare(workerId: string, provider: ProviderId): Promise<{ data?: PreparedHandoff; error?: string }>;
  onStart(workerId: string, token: string): Promise<string | null>;
  onDirectSwitch(workerId: string, provider: ProviderId): Promise<string | null>;
  onClose(): void;
};

const STAGES = [
  { id: "checking", label: "檢查目標工作能量" },
  { id: "summarizing", label: "整理目前工作記憶" },
  { id: "fallback", label: "建立本機備援交接包" },
  { id: "bootstrapping", label: "新 LLM 讀取交接" },
] as const;

const providerLabel = (provider: ProviderId) => provider === "claude" ? "Claude Code" : "Codex";

export function ProviderHandoffDialog({ worker, toProvider, onPrepare, onStart, onDirectSwitch, onClose }: Props) {
  const initialTerminalHandoffId = useRef(
    worker.handoff?.toProvider === toProvider && ["completed", "failed"].includes(worker.handoff.stage)
      ? worker.handoff.id
      : null,
  );
  const [prepared, setPrepared] = useState<PreparedHandoff | null>(null);
  const [checking, setChecking] = useState(true);
  const [acknowledged, setAcknowledged] = useState(false);
  const [starting, setStarting] = useState(false);
  const [switchingDirectly, setSwitchingDirectly] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef);
  const candidate = worker.handoff?.toProvider === toProvider ? worker.handoff : null;
  const progress = candidate && (
    !["completed", "failed"].includes(candidate.stage) || candidate.id !== initialTerminalHandoffId.current
  ) ? candidate : null;
  const fromProvider = progress?.fromProvider ?? worker.provider;
  const active = progress && !["completed", "failed"].includes(progress.stage);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !active) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active, onClose]);

  useEffect(() => {
    let cancelled = false;
    setChecking(true);
    setPrepared(null);
    setError(null);
    void onPrepare(worker.id, toProvider).then((result) => {
      if (cancelled) return;
      setChecking(false);
      if (result.error) setError(result.error);
      else setPrepared(result.data ?? null);
    });
    return () => { cancelled = true; };
  }, [worker.id, toProvider, onPrepare]);

  async function start() {
    if (!prepared || !acknowledged) return;
    setStarting(true);
    setError(null);
    const startError = await onStart(worker.id, prepared.handoffToken);
    setStarting(false);
    if (startError) setError(startError);
  }

  async function directSwitch() {
    if (!acknowledged) return;
    setSwitchingDirectly(true);
    setError(null);
    const switchError = await onDirectSwitch(worker.id, toProvider);
    setSwitchingDirectly(false);
    if (switchError) setError(switchError);
    else onClose();
  }

  const stageIndex = progress ? STAGES.findIndex((stage) => stage.id === progress.stage) : -1;

  return (
    <div ref={dialogRef} className="handoff-dialog" role="dialog" aria-modal="true" aria-labelledby="handoff-title">
      <div className="handoff-dialog__card">
        <button type="button" className="handoff-dialog__close" onClick={onClose} disabled={Boolean(active)} aria-label="關閉交接視窗">×</button>
        <header className="handoff-dialog__header">
          <span>SHIFT CHANGE · LLM HANDOFF</span>
          <h2 id="handoff-title">替 {worker.name} 進行交接班</h2>
          <div className="handoff-dialog__route">
            <strong>{providerLabel(fromProvider)}</strong><i>→</i><strong>{providerLabel(toProvider)}</strong>
          </div>
        </header>

        {checking && !progress && <div className="handoff-dialog__checking"><i />正在確認登入狀態與即時工作能量…</div>}

        {prepared && !progress && <>
          <section className="handoff-dialog__energy">
            <div><span>TARGET ENERGY</span><strong>{providerLabel(toProvider)} 可進行交接</strong></div>
            <div className="handoff-dialog__meters">
              {prepared.usage.windows.map((window) => (
                <div key={window.id}><span>{window.label}</span><b><i style={{ width: `${window.remainingPercent}%` }} /></b><strong>{window.remainingPercent}%</strong></div>
              ))}
            </div>
          </section>

          <section className="handoff-dialog__warning">
            <h3>切換前請先確認</h3>
            <p>這是讓新 LLM 接手工作，不是完整複製原生記憶。</p>
            <ul>{prepared.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
            <label><input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} /><span>我了解跨 LLM 可能遺漏上下文、工具狀態與未完成工作。</span></label>
          </section>
        </>}

        {progress && <section className={`handoff-dialog__progress handoff-dialog__progress--${progress.stage}`}>
          <div className="handoff-dialog__progress-head"><span>{progress.stage === "completed" ? "交接完成" : progress.stage === "failed" ? "交接失敗" : "正在交接"}</span><strong>{progress.message}</strong></div>
          <ol>
            {STAGES.filter((stage) => stage.id !== "fallback" || progress.stage === "fallback" || progress.source === "local_fallback").map((stage, index) => {
              const done = progress.stage === "completed" || stageIndex > index || (stage.id === "fallback" && progress.source === "local_fallback");
              const current = progress.stage === stage.id;
              return <li key={stage.id} className={done ? "is-done" : current ? "is-current" : ""}><i>{done ? "✓" : current ? "•" : ""}</i><span>{stage.label}</span></li>;
            })}
          </ol>
          {progress.source === "local_fallback" && <p>來源 LLM 無法完成整理，本次使用本機任務紀錄交接。</p>}
          {progress.error && <div className="handoff-dialog__error">{progress.error}</div>}
        </section>}

        {error && <div className="handoff-dialog__error" role="alert">{error}</div>}

        <footer className="handoff-dialog__actions">
          <button type="button" onClick={onClose} disabled={Boolean(active)}>{progress?.stage === "completed" || progress?.stage === "failed" ? "完成" : "取消"}</button>
          {!progress && <button type="button" className="handoff-dialog__direct" disabled={!prepared || !acknowledged || starting || switchingDirectly || checking} onClick={() => void directSwitch()}>{switchingDirectly ? "直接切換中…" : "不交接，直接切換"}</button>}
          {!progress && <button type="button" className="handoff-dialog__start" disabled={!prepared || !acknowledged || starting || switchingDirectly || checking} onClick={() => void start()}>{starting ? "啟動交接中…" : "整理記憶並切換"}</button>}
        </footer>
      </div>
    </div>
  );
}
