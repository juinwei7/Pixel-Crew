import { useEffect, useMemo, useRef, useState } from "react";
import { useFocusTrap } from "../hooks/useFocusTrap";
import type { CollaborationMode, CollaborationTask, PreparedCollaboration, WorkerState } from "../types";

type Props = {
  source: WorkerState;
  workers: WorkerState[];
  tasks: CollaborationTask[];
  onPrepare(input: { sourceWorkerId: string; targetWorkerId: string; mode: CollaborationMode; objective: string; acceptanceCriteria: string[] }): Promise<{ data?: PreparedCollaboration; error?: string }>;
  onStart(sourceWorkerId: string, token: string): Promise<string | null>;
  onCancel(id: string): Promise<string | null>;
  onAdopt(id: string): Promise<string | null>;
  onHandled(id: string): Promise<string | null>;
  onClose(): void;
};

const statusLabel: Record<CollaborationTask["status"], string> = {
  queued: "排隊中", running: "協作 NPC 執行中", returning: "已回到來源 NPC，繼續完成中", completed: "全流程已完成", failed: "失敗", cancelled: "已取消",
};

export function CollaborationDialog({ source, workers, tasks, onPrepare, onStart, onCancel, onAdopt, onHandled, onClose }: Props) {
  const candidates = workers.filter((worker) => worker.id !== source.id && worker.workspacePath === source.workspacePath);
  const [targetId, setTargetId] = useState(candidates[0]?.id ?? "");
  const [mode, setMode] = useState<CollaborationMode>("review");
  const [objective, setObjective] = useState("");
  const [criteria, setCriteria] = useState("");
  const [prepared, setPrepared] = useState<PreparedCollaboration | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef);
  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [onClose]);
  const related = useMemo(() => tasks
    .filter((task) => task.sourceWorkerId === source.id || task.targetWorkerId === source.id)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt)), [source.id, tasks]);

  async function prepare() {
    setWorking(true); setError(null); setPrepared(null);
    const result = await onPrepare({
      sourceWorkerId: source.id, targetWorkerId: targetId, mode, objective,
      acceptanceCriteria: criteria.split("\n").map((line) => line.trim()).filter(Boolean),
    });
    setWorking(false);
    if (result.error) setError(result.error);
    else setPrepared(result.data ?? null);
  }

  async function start() {
    if (!prepared) return;
    setWorking(true); setError(null);
    const result = await onStart(source.id, prepared.collaborationToken);
    setWorking(false);
    if (result) setError(result);
    else { setPrepared(null); setObjective(""); setCriteria(""); }
  }

  async function action(run: () => Promise<string | null>) {
    setWorking(true); setError(null);
    const result = await run();
    setWorking(false);
    if (result) setError(result);
  }

  return (
    <div ref={dialogRef} className="handoff-dialog collaboration-dialog" role="dialog" aria-modal="true" aria-labelledby="collaboration-title">
      <div className="handoff-dialog__card collaboration-dialog__card">
        <button type="button" className="handoff-dialog__close" onClick={onClose} aria-label="關閉協作視窗">×</button>
        <header className="handoff-dialog__header">
          <span>NPC COLLABORATION · READ ONLY</span>
          <h2 id="collaboration-title">替 {source.name} 找隊友</h2>
          <p className="collaboration-dialog__lead">由你指派 Consult 或 Review；目標 NPC 唯讀回報後，結果會自動交回來源 NPC 繼續完成。需要權限或認證時才會停下來詢問你。</p>
        </header>

        <section className="collaboration-dialog__form">
          <label>協作 NPC<select value={targetId} onChange={(event) => { setTargetId(event.target.value); setPrepared(null); }} disabled={Boolean(prepared)}>
            {candidates.length === 0 && <option value="">同一工作位置沒有其他 NPC</option>}
            {candidates.map((worker) => <option key={worker.id} value={worker.id}>{worker.name} · {worker.provider === "claude" ? "Claude Code" : "Codex"}{worker.busy ? "（忙碌）" : ""}</option>)}
          </select></label>
          {candidates.length === 0 && <div className="collaboration-dialog__empty-target" role="status">
            <strong>目前沒有可協作的 NPC</strong>
            <span>Phase 1 只允許相同工作位置。請從左下角「＋」新增 NPC，並選擇與 {source.name} 相同的資料夾：</span>
            <code>{source.workspacePath}</code>
            <small>也可以搬移既有 NPC，但搬移會重設該 NPC 的對話 session。</small>
          </div>}
          <div className="collaboration-dialog__modes">
            <button type="button" className={mode === "review" ? "is-active" : ""} onClick={() => { setMode("review"); setPrepared(null); }}>Review<span>檢查成果、風險與驗收條件</span></button>
            <button type="button" className={mode === "consult" ? "is-active" : ""} onClick={() => { setMode("consult"); setPrepared(null); }}>Consult<span>提供第二意見與下一步建議</span></button>
          </div>
          <label>協作目標<textarea value={objective} maxLength={4000} rows={3} placeholder="例如：檢查目前 NPC collaboration API 是否有競態與權限漏洞" onChange={(event) => { setObjective(event.target.value); setPrepared(null); }} /></label>
          <label>驗收條件 <small>每行一項，最多 8 項</small><textarea value={criteria} rows={3} placeholder={"不修改任何檔案\n指出具體檔案與風險\n提出可執行的下一步"} onChange={(event) => { setCriteria(event.target.value); setPrepared(null); }} /></label>
        </section>

        {prepared && <section className="handoff-dialog__warning collaboration-dialog__confirm">
          <h3>準備完成</h3>
          <p>完成後會自動交回 {source.name} 並繼續執行，不需要再手動轉交。</p>
          <ul>{prepared.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
          <button type="button" onClick={() => void start()} disabled={working}>確認並啟動唯讀協作</button>
        </section>}
        {error && <div className="handoff-dialog__error" role="alert">{error}</div>}
        <div className="collaboration-dialog__actions">
          {!prepared && <button type="button" className="collaboration-dialog__primary" disabled={working || !targetId || !objective.trim()} onClick={() => void prepare()}>{working ? "檢查中…" : "檢查 NPC 與工作能量"}</button>}
        </div>

        {related.length > 0 && <section className="collaboration-dialog__history">
          <h3>協作紀錄</h3>
          {related.map((task) => {
            const target = workers.find((worker) => worker.id === task.targetWorkerId);
            return <article key={task.id} className={`collaboration-task collaboration-task--${task.status}`}>
              <header><div><strong>{task.mode === "review" ? "Review" : "Consult"} · {target?.name ?? "未知 NPC"}</strong><span>{statusLabel[task.status]}</span></div><time>{new Date(task.createdAt).toLocaleString()}</time></header>
              <p>{task.objective}</p>
              {task.result && <div className="collaboration-task__result"><b>{task.result.verdict}</b><p>{task.result.summary}</p>
                {task.result.findings.length > 0 && <ul>{task.result.findings.map((finding, index) => <li key={`${finding.title}:${index}`}><strong>{finding.severity} · {finding.title}</strong><span>{finding.detail}{finding.file ? ` — ${finding.file}${finding.line ? `:${finding.line}` : ""}` : ""}</span></li>)}</ul>}
                {task.result.recommendedNextAction && <small>建議下一步：{task.result.recommendedNextAction}</small>}
              </div>}
              {task.continuationResult && <div className="collaboration-task__continuation"><b>{source.name} 最終結果</b><p>{task.continuationResult}</p></div>}
              {task.error && <div className="handoff-dialog__error">{task.error}</div>}
              <footer>
                {["running", "returning"].includes(task.status) && <button type="button" onClick={() => void action(() => onCancel(task.id))}>取消協作</button>}
                {task.status === "completed" && !task.adoptedAt && task.sourceWorkerId === source.id && <button type="button" className="collaboration-dialog__primary" onClick={() => void action(() => onAdopt(task.id))}>交回 {source.name}</button>}
                {task.adoptedAt && <span>{task.status === "returning" ? `已自動交回 ${source.name}` : "已自動交回來源 NPC"}</span>}
                {!task.handledAt && !["queued", "running", "returning"].includes(task.status) && <button type="button" onClick={() => void action(() => onHandled(task.id))}>標為已處理</button>}
              </footer>
            </article>;
          })}
        </section>}
      </div>
    </div>
  );
}
