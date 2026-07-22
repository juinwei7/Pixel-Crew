import { useEffect, useMemo, useRef, useState } from "react";
import { useFocusTrap } from "../hooks/useFocusTrap";
import type { CollaborationTask, Department, DepartmentMission, PreparedMission, WorkerState } from "../types";
import { roomName } from "../workspace";
import { RichText } from "./RichText";

type Props = {
  boss: WorkerState;
  workers: WorkerState[];
  missions: DepartmentMission[];
  legacyTasks?: CollaborationTask[];
  departmentRecord?: Department;
  onPrepare(input: { bossWorkerId: string; objective: string; acceptanceCriteria: string[] }): Promise<{ data?: PreparedMission; error?: string }>;
  onStart(bossWorkerId: string, token: string): Promise<string | null>;
  onCancel(id: string): Promise<string | null>;
  onRetryReview(id: string): Promise<string | null>;
  onApprovePlan(id: string): Promise<string | null>;
  onResolve(id: string, action: "retry" | "retry_execute" | "reassign" | "accept_risk" | "guide", guidance?: string, workerId?: string): Promise<string | null>;
  onAsk?(missionId: string, question: string): Promise<string | null>;
  onClose(): void;
  embedded?: boolean;
  focusMode?: boolean;
  onSelectWorker?(id: string): void;
};

const statusLabel: Record<DepartmentMission["status"], string> = {
  planning: "AI 規劃中",
  executing: "部門執行中",
  reviewing: "專家協作中",
  needs_attention: "需要你決定",
  completed: "Mission 完成",
  failed: "Mission 失敗",
  cancelled: "已取消",
};

export function DepartmentMissionDialog({ boss, workers, missions, legacyTasks = [], departmentRecord, onPrepare, onStart, onCancel, onRetryReview, onApprovePlan, onResolve, onAsk, onClose, embedded = false, focusMode = false, onSelectWorker }: Props) {
  const [objective, setObjective] = useState("");
  const [criteria, setCriteria] = useState("");
  const [prepared, setPrepared] = useState<PreparedMission | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [guidance, setGuidance] = useState("");
  const [reassignWorkerId, setReassignWorkerId] = useState("");
  const [continuationMode, setContinuationMode] = useState<"ask" | "work">("ask");
  const [question, setQuestion] = useState("");
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef, !embedded);
  const department = workers.filter((worker) => boss.departmentId
    ? worker.departmentId === boss.departmentId
    : worker.workspacePath === boss.workspacePath);
  const related = useMemo(() => missions
    .filter((mission) => boss.departmentId ? mission.departmentId === boss.departmentId : mission.workspacePath === boss.workspacePath)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt)), [boss.departmentId, boss.workspacePath, missions]);
  const activeMission = related.find((mission) => ["planning", "executing", "reviewing", "needs_attention"].includes(mission.status));
  const latestTerminal = related.find((mission) => !["planning", "executing", "reviewing", "needs_attention"].includes(mission.status));
  const followUpTurns = latestTerminal
    ? boss.turns.filter((turn) => turn.departmentFollowUpMissionId === latestTerminal.id)
    : [];
  const legacyRelated = legacyTasks
    .filter((task) => task.workspacePath === boss.workspacePath)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));

  useEffect(() => {
    if (embedded) return;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [embedded, onClose]);

  useEffect(() => {
    setContinuationMode("ask");
    setObjective("");
    setCriteria("");
    setPrepared(null);
    setQuestion("");
    setError(null);
  }, [latestTerminal?.id]);

  async function prepare() {
    setWorking(true); setError(null); setPrepared(null);
    const result = await onPrepare({
      bossWorkerId: boss.id,
      objective: latestTerminal && continuationMode === "work"
        ? `延續前次 Mission「${latestTerminal.objective}」的後續工作：${objective}`
        : objective,
      acceptanceCriteria: criteria.split("\n").map((line) => line.trim()).filter(Boolean),
    });
    setWorking(false);
    if (result.error) setError(result.error);
    else setPrepared(result.data ?? null);
  }

  async function start() {
    if (!prepared) return;
    setWorking(true); setError(null);
    const result = await onStart(boss.id, prepared.missionToken);
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

  async function askDepartment() {
    if (!latestTerminal || !onAsk || !question.trim()) return;
    setWorking(true); setError(null);
    const result = await onAsk(latestTerminal.id, question.trim());
    setWorking(false);
    if (result) setError(result);
    else setQuestion("");
  }

  const newMissionForm = <>
    {latestTerminal && <div className="department-continuation__parent"><span>延續前次報告</span><strong>{latestTerminal.objective}</strong><small>仍會重新規劃並等待你核准，不會直接修改。</small></div>}
    <section className="collaboration-dialog__form">
      <label>{latestTerminal ? "後續工作目標" : "交辦目標"}<textarea value={objective} maxLength={4000} rows={4} placeholder={latestTerminal ? "例如：依照報告中的風險，補齊整合測試與錯誤處理" : "例如：完成會員權限 API，包含實作、測試與文件"} onChange={(event) => { setObjective(event.target.value); setPrepared(null); }} /></label>
      <label>驗收條件 <small>每行一項，最多 8 項</small><textarea value={criteria} rows={4} placeholder={"AI 拆成 2～5 個步驟\n同一時間只有一個 NPC 執行\nReview 退件可自動修正\n完整測試通過"} onChange={(event) => { setCriteria(event.target.value); setPrepared(null); }} /></label>
    </section>
    {prepared && <section className="handoff-dialog__warning collaboration-dialog__confirm">
      <h3>部門已就緒 · {prepared.members.length} NPC</h3>
      <p>確認後 AI 會選擇最小充分流程，並由部門主管負責分工、接續與彙整，直到完成、失敗、需要權限，或 Review 超過 {prepared.maxCorrections} 輪。</p>
      <ul>{prepared.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
      <button type="button" onClick={() => void start()} disabled={working}>確認並交給部門</button>
    </section>}
    <div className="collaboration-dialog__actions">
      {!prepared && <button type="button" className="collaboration-dialog__primary" disabled={working || !objective.trim() || !criteria.trim() || department.length < 1} onClick={() => void prepare()}>{working ? "檢查中…" : "檢查部門與工作能量"}</button>}
    </div>
    {department.length === 1 && <div className="collaboration-dialog__empty-target" role="status"><strong>單人部門模式</strong><span>可以交辦 Execute 工作；沒有第二位 NPC 時，AI 不會安排獨立 Review。</span></div>}
  </>;

  const content = <div className={`handoff-dialog__card mission-dialog__card ${embedded ? "mission-dialog__card--embedded" : ""} ${focusMode ? "mission-dialog__card--focus" : ""}`}>
      {!embedded && <button type="button" className="handoff-dialog__close" onClick={onClose} aria-label="關閉部門任務視窗">×</button>}
      <header className="handoff-dialog__header">
        <span>OWNER DIRECTIVE · AI ROUTED</span>
        <h2 id="mission-title">交給 {departmentRecord?.name ?? roomName(boss.workspacePath)} 部門</h2>
        <p className="collaboration-dialog__lead">你是老闆，只要描述目標與驗收條件。系統會由 {boss.name} 擔任部門主管，自行判斷使用快速 Consult／Review，或拆成完整 Department Mission；權限、認證與重大決定仍會回來詢問你。</p>
      </header>

      <section className="mission-dialog__department">
        <div><span>你的身份</span><strong>老闆 · 最終決策者</strong></div>
        <div><span>部門主管</span><strong>{boss.name}{boss.persona?.role ? ` · ${boss.persona.role}` : ""}</strong></div>
        <div><span>成員</span><strong>{department.length} 位 NPC · {department.map((worker) => worker.name).join("、")}</strong></div>
      </section>

      <section className="mission-dialog__roster" aria-label="部門成員">
        {department.map((worker) => {
          const currentStep = activeMission?.currentStepIndex == null ? null : activeMission.steps[activeMission.currentStepIndex];
          const assigned = currentStep?.assigneeWorkerId === worker.id;
          const state = worker.busy ? "執行中" : worker.turns.some((turn) => turn.items.some((item) => item.kind === "approval" && item.status === "pending")) ? "等待核准" : "待命";
          return <button key={worker.id} type="button" onClick={() => onSelectWorker?.(worker.id)} disabled={!onSelectWorker} className={assigned ? "mission-dialog__member--assigned" : ""}>
            <span><strong>{worker.name}</strong><small>{worker.persona?.role || (worker.id === boss.id ? "部門主管" : "部門成員")}</small></span>
            <em>{assigned ? "目前步驟" : state}</em>
          </button>;
        })}
      </section>

      {!activeMission && !latestTerminal && newMissionForm}
      {error && <div className="handoff-dialog__error" role="alert">{error}</div>}

      {related.length > 0 && <section className="mission-dialog__history">
        <h3>部門工作</h3>
        {related.map((mission) => {
          const current = mission.currentStepIndex == null ? null : mission.steps[mission.currentStepIndex];
          const completed = mission.steps.filter((step) => step.status === "completed").length;
          const strategy = mission.steps[0]?.kind === "consult" ? "QUICK CONSULT" : mission.steps[0]?.kind === "review" ? "QUICK REVIEW" : "DEPARTMENT MISSION";
          return <article key={mission.id} className={`mission-card mission-card--${mission.status}`}>
            <header><div><strong>{mission.objective}</strong><span>{mission.steps.length > 0 ? `${strategy} · ` : ""}{statusLabel[mission.status]}</span></div><time>{new Date(mission.createdAt).toLocaleString()}</time></header>
            {mission.planSummary && <p>{mission.planSummary}</p>}
            {mission.steps.length > 0 && <div className="mission-card__progress"><i style={{ width: `${Math.round((completed / mission.steps.length) * 100)}%` }} /><span>{completed}/{mission.steps.length}{current ? ` · ${current.title}` : ""}</span></div>}
            {mission.steps.length > 0 && <ol>{mission.steps.map((step, index) => {
              const assignee = workers.find((worker) => worker.id === step.assigneeWorkerId);
              return <li key={step.id} className={`mission-step mission-step--${step.status}`}>
                <div><b>{index + 1}. {step.title}</b><span>{step.kind === "review" ? "REVIEW" : step.kind === "consult" ? "CONSULT" : step.kind === "synthesize" ? "主管彙整" : "EXECUTE"} · {assignee?.name ?? "未知 NPC"}{step.attempt > 1 ? ` · 第 ${step.attempt} 輪` : ""}</span></div>
                {step.status !== "pending" && <small>{step.status === "running" ? "執行中" : step.status === "failed" ? "失敗" : "完成"}</small>}
                {step.reviewResult && <div className="mission-step__review">
                  <p><strong>{step.reviewResult.verdict}</strong> · {step.reviewResult.summary}</p>
                  {step.reviewResult.findings.length > 0 && <div><b>發現</b><ul>{step.reviewResult.findings.map((item, findingIndex) => <li key={`${item.title}-${findingIndex}`}><strong>{item.severity} · {item.title}</strong>{item.detail ? `：${item.detail}` : ""}{item.file ? `（${item.file}${item.line ? `:${item.line}` : ""}）` : ""}</li>)}</ul></div>}
                  {step.reviewResult.risks.length > 0 && <div><b>風險</b><ul>{step.reviewResult.risks.map((item) => <li key={item}>{item}</li>)}</ul></div>}
                  {step.reviewResult.openQuestions.length > 0 && <div><b>未決問題</b><ul>{step.reviewResult.openQuestions.map((item) => <li key={item}>{item}</li>)}</ul></div>}
                  {step.reviewResult.recommendedNextAction && <p><b>建議：</b>{step.reviewResult.recommendedNextAction}</p>}
                </div>}
                {!step.reviewResult && step.result && <p>{step.result}</p>}
              </li>;
            })}</ol>}
            {mission.error && <div className="handoff-dialog__error">{mission.error}</div>}
            {(mission.status === "failed" || (mission.status === "needs_attention" && mission.attentionReason !== "plan_approval")) && <div className="mission-card__resolution">
              <label>補充指示<textarea value={guidance} rows={2} maxLength={2000} placeholder="告訴部門要補充什麼、接受哪些限制" onChange={(event) => setGuidance(event.target.value)} /></label>
              <div>
                <button type="button" onClick={() => void action(() => onResolve(mission.id, "retry", guidance))}>{mission.status === "failed" ? "從失敗處恢復" : "重試目前步驟"}</button>
                {guidance.trim() && <button type="button" onClick={() => void action(() => onResolve(mission.id, "guide", guidance))}>補充指示並重試</button>}
                {current?.kind === "review" && <button type="button" onClick={() => void action(() => onResolve(mission.id, "retry_execute", guidance))}>退回 Execute</button>}
                {current?.kind === "review" && current.reviewResult && <button type="button" onClick={() => void action(() => onResolve(mission.id, "accept_risk", guidance))}>接受風險繼續</button>}
              </div>
              {current && <div><select aria-label="重新指派 NPC" value={reassignWorkerId} onChange={(event) => setReassignWorkerId(event.target.value)}><option value="">選擇其他 NPC</option>{department.filter((worker) => worker.id !== current.assigneeWorkerId).map((worker) => <option key={worker.id} value={worker.id}>{worker.name}{worker.persona?.role ? ` · ${worker.persona.role}` : ""}</option>)}</select><button type="button" disabled={!reassignWorkerId} onClick={() => void action(() => onResolve(mission.id, "reassign", guidance, reassignWorkerId))}>重新指派</button></div>}
            </div>}
            <footer>
              {mission.status === "needs_attention" && mission.attentionReason === "plan_approval" && <button type="button" className="collaboration-dialog__primary" onClick={() => void action(() => onApprovePlan(mission.id))}>核准計畫並開始</button>}
              {["planning", "executing", "reviewing", "needs_attention"].includes(mission.status) && <button type="button" onClick={() => void action(() => onCancel(mission.id))}>取消 Mission</button>}
              {mission.status === "needs_attention" && current?.kind === "review" && mission.attentionReason !== "plan_approval" && <button type="button" className="collaboration-dialog__primary" onClick={() => void action(() => onRetryReview(mission.id))}>重新 Review</button>}
              {mission.correctionCount > 0 && <span>已修正 {mission.correctionCount}/{mission.maxCorrections} 輪</span>}
            </footer>
          </article>;
        })}
      </section>}
      {!activeMission && latestTerminal && <section className="department-continuation" aria-label="部門報告後續">
        <header>
          <div><span>CONTINUE WITH DEPARTMENT</span><strong>接著追問或交辦</strong></div>
          <div className="department-continuation__modes" aria-label="後續方式">
            <button type="button" className={continuationMode === "ask" ? "active" : ""} onClick={() => { setContinuationMode("ask"); setPrepared(null); setError(null); }}>詢問部門</button>
            <button type="button" className={continuationMode === "work" ? "active" : ""} onClick={() => {
              setContinuationMode("work");
              setPrepared(null);
              setError(null);
              if (!criteria.trim()) setCriteria(latestTerminal.acceptanceCriteria.join("\n"));
            }}>交辦後續工作</button>
          </div>
        </header>
        {continuationMode === "ask" ? <>
          <p>由 {boss.name} 根據這份報告唯讀回答；如果內容其實需要修改，主管會請你改用「交辦後續工作」。</p>
          {followUpTurns.length > 0 && <div className="department-continuation__thread">{followUpTurns.map((turn) => {
            const answer = turn.items.flatMap((item) => item.kind === "assistant_text" || item.kind === "system_error" ? [item.text] : []).join("\n").trim();
            return <article key={turn.key} className={`department-continuation__turn department-continuation__turn--${turn.status}`}>
              <div><span>你</span><p>{turn.command.replace(/^部門追問：/, "")}</p></div>
              <div><span>{boss.name}</span>{answer ? <RichText text={answer} compact /> : <p>{turn.status === "running" ? "主管正在整理報告脈絡…" : "這次追問沒有取得可讀回覆"}</p>}</div>
            </article>;
          })}</div>}
          <div className="department-continuation__composer">
            <textarea value={question} rows={3} maxLength={4000} placeholder="例如：為什麼採用這個方案？目前最大的剩餘風險是什麼？" onChange={(event) => setQuestion(event.target.value)} onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); void askDepartment(); }
            }} />
            <button type="button" disabled={working || boss.busy || !question.trim() || !onAsk} onClick={() => void askDepartment()}>{working || boss.busy ? "主管回覆中…" : "詢問部門"}</button>
          </div>
          <small>唯讀追問 · ⌘/Ctrl + Enter 送出</small>
        </> : newMissionForm}
      </section>}
      {legacyRelated.length > 0 && <details className="mission-dialog__legacy">
        <summary>過往單次 NPC 協作 · {legacyRelated.length}</summary>
        {legacyRelated.map((task) => {
          const target = workers.find((worker) => worker.id === task.targetWorkerId);
          return <article key={task.id}><div><strong>{task.mode === "review" ? "Review" : "Consult"} · {target?.name ?? "未知 NPC"}</strong><span>{task.status}</span></div><p>{task.objective}</p>{task.result && <small>{task.result.verdict} · {task.result.summary}</small>}</article>;
        })}
      </details>}
    </div>;

  if (embedded) return <section ref={dialogRef} className="mission-workspace" aria-labelledby="mission-title">{content}</section>;
  return <div ref={dialogRef} className="handoff-dialog mission-dialog" role="dialog" aria-modal="true" aria-labelledby="mission-title">{content}</div>;
}
