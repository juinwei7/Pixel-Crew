import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useFocusTrap } from "../hooks/useFocusTrap";
import type { ApprovalDecision, CollaborationTask, CommandSubmission, Department, DepartmentMission, DepartmentThreadPayload, MissionExecutionEvent, PreparedMission, ProviderId, RunnerEvent, ToolCallItem, WorkerState } from "../types";
import { roomName } from "../workspace";
import { RichText } from "./RichText";
import { TaskComposer } from "./TaskComposer";
import { ToolGroup, ToolRow } from "./QuestLog";

type Props = {
  boss: WorkerState;
  workers: WorkerState[];
  missions: DepartmentMission[];
  legacyTasks?: CollaborationTask[];
  departmentRecord?: Department;
  onPrepare(input: { bossWorkerId: string; objective: string; acceptanceCriteria: string[]; images?: CommandSubmission["images"]; documents?: CommandSubmission["documents"]; clientMessageId?: string; idempotencyKey?: string; parentMissionId?: string }): Promise<{ data?: PreparedMission; error?: string }>;
  onStart(bossWorkerId: string, token: string): Promise<string | null>;
  onLoadThread?(departmentId: string): Promise<{ data?: DepartmentThreadPayload; error?: string }>;
  onMessageDepartment?(departmentId: string, submission: CommandSubmission, acceptanceCriteria?: string[]): Promise<{ data?: DepartmentThreadPayload; error?: string }>;
  onResetSessions?(departmentId: string, confirm: boolean, workerIds?: string[]): Promise<{ data?: { requiresConfirmation?: boolean; members?: Array<{ workerId: string; name: string; provider: ProviderId; model: string | null }>; results?: Array<{ workerId: string; name: string; ok: boolean; error: string | null }>; retryWorkerIds?: string[]; historyClearedAt?: string | null }; error?: string }>;
  resetRequestKey?: number;
  onCancel(id: string): Promise<string | null>;
  onRetryReview(id: string): Promise<string | null>;
  onApprovePlan(id: string): Promise<string | null>;
  onResolve(id: string, action: "retry" | "retry_execute" | "reassign" | "accept_risk" | "guide", guidance?: string, workerId?: string): Promise<string | null>;
  onResolveApproval?(missionId: string, approvalId: string, decision: ApprovalDecision): Promise<string | null>;
  onAsk?(missionId: string, question: string): Promise<string | null>;
  onClose(): void;
  embedded?: boolean;
  focusMode?: boolean;
  missionDetailId?: string | null;
  focusSection?: "team" | "history" | null;
  onSelectWorker?(id: string): void;
  composerHost?: Element | null;
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

export async function prepareAndStartDepartmentMission(
  input: { bossWorkerId: string; objective: string; acceptanceCriteria: string[]; images?: CommandSubmission["images"]; documents?: CommandSubmission["documents"]; clientMessageId?: string; idempotencyKey?: string; parentMissionId?: string },
  onPrepare: Props["onPrepare"],
  onStart: Props["onStart"],
): Promise<string | null> {
  const prepared = await onPrepare(input);
  if (prepared.error || !prepared.data) return prepared.error || "部門目前無法接受這項工作";
  return onStart(input.bossWorkerId, prepared.data.missionToken);
}

function missionActivityLabel({ event }: MissionExecutionEvent): string {
  if (event.type === "user_message") return event.text;
  if (event.type === "tool_call_start") return `開始使用工具：${event.name}`;
  if (event.type === "tool_call_result") return event.isError ? "工具執行失敗" : "工具執行完成";
  if (event.type === "approval_requested") return `等待核准：${event.request.title}`;
  if (event.type === "approval_resolved") return event.decision === "deny" ? "核准已拒絕" : "核准已允許";
  if (event.type === "turn_end") return event.isError ? "本輪工作失敗" : "本輪工作完成";
  if (event.type === "error") return `錯誤：${event.message}`;
  return "任務狀態已更新";
}

type MissionActivityTone = "ok" | "error" | "pending" | "neutral";

function missionActivityTone(event: RunnerEvent): MissionActivityTone {
  if (event.type === "error") return "error";
  if (event.type === "turn_end") return event.isError ? "error" : "ok";
  if (event.type === "approval_requested") return "pending";
  if (event.type === "approval_resolved") return event.decision === "deny" ? "error" : "ok";
  return "neutral";
}

const MISSION_ACTIVITY_TONE_ICON: Record<MissionActivityTone, string> = { ok: "✓", error: "✕", pending: "⏳", neutral: "•" };

type MissionActivityGroup =
  | { kind: "tools"; key: string; workerId: string; items: ToolCallItem[] }
  | { kind: "event"; key: string; workerId: string; label: string; tone: MissionActivityTone };

// Consecutive tool_call_start/tool_call_result pairs from the same worker collapse
// into one ToolGroup instead of two flat rows per call — the raw event stream
// otherwise renders dozens of near-duplicate "開始使用工具" / "工具執行完成" rows.
function groupMissionActivity(events: MissionExecutionEvent[]): MissionActivityGroup[] {
  const groups: MissionActivityGroup[] = [];
  const pending = new Map<string, ToolCallItem>();
  events.forEach(({ workerId, event }, index) => {
    if (event.type === "tool_call_start") {
      const pendingKey = `${workerId}\0${event.id}`;
      const item: ToolCallItem = { kind: "tool_call", key: pendingKey, id: event.id, name: event.name, input: event.input, isError: false, status: "running" };
      pending.set(pendingKey, item);
      const last = groups[groups.length - 1];
      if (last?.kind === "tools" && last.workerId === workerId) last.items.push(item);
      else groups.push({ kind: "tools", key: `tools-${index}`, workerId, items: [item] });
      return;
    }
    if (event.type === "tool_call_result") {
      const item = pending.get(`${workerId}\0${event.id}`);
      if (item) {
        item.output = event.output;
        item.isError = event.isError;
        item.status = "done";
        return;
      }
    }
    groups.push({
      kind: "event",
      key: `event-${index}`,
      workerId,
      label: missionActivityLabel({ workerId, stepId: null, event }),
      tone: missionActivityTone(event),
    });
  });
  return groups;
}

export function DepartmentMissionDialog({ boss, workers, missions, legacyTasks = [], departmentRecord, onPrepare, onStart, onLoadThread, onMessageDepartment, onResetSessions, resetRequestKey = 0, onCancel, onRetryReview, onApprovePlan, onResolve, onResolveApproval, onAsk, onClose, embedded = false, focusMode = false, missionDetailId = null, focusSection = null, onSelectWorker, composerHost }: Props) {
  const [criteria, setCriteria] = useState("");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [guidance, setGuidance] = useState("");
  const [reassignWorkerId, setReassignWorkerId] = useState("");
  const [threadPayload, setThreadPayload] = useState<DepartmentThreadPayload | null>(null);
  const [threadLoading, setThreadLoading] = useState(false);
  const [resetPreview, setResetPreview] = useState<Array<{ workerId: string; name: string; provider: ProviderId; model: string | null }> | null>(null);
  const [resetResults, setResetResults] = useState<Array<{ workerId: string; name: string; ok: boolean; error: string | null }> | null>(null);
  const handledResetRequest = useRef(resetRequestKey);
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef, !embedded);
  const department = workers.filter((worker) => boss.departmentId
    ? worker.departmentId === boss.departmentId
    : worker.workspacePath === boss.workspacePath);
  const historyClearedAt = threadPayload?.thread.historyClearedAt ?? null;
  const related = useMemo(() => {
    if (missionDetailId) return missions.filter((mission) => mission.id === missionDetailId);
    return missions
      .filter((mission) => mission.origin !== "boss")
      .filter((mission) => boss.departmentId ? mission.departmentId === boss.departmentId : mission.workspacePath === boss.workspacePath)
      .filter((mission) => !historyClearedAt || mission.createdAt > historyClearedAt)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }, [boss.departmentId, boss.workspacePath, historyClearedAt, missionDetailId, missions]);
  const activeMission = related.find((mission) => ["planning", "executing", "reviewing", "needs_attention"].includes(mission.status));
  const latestTerminal = related.find((mission) => !["planning", "executing", "reviewing", "needs_attention"].includes(mission.status));
  // The one Mission relevant to what you're currently looking at — either the
  // in-progress one, or (if none) the most recent finished one. Everything
  // else for this department is older/unrelated and stays tucked away below,
  // so it never gets confused with what actually needs your attention now.
  const currentMission = activeMission ?? latestTerminal;
  const historicalMissions = related.filter((mission) => mission.id !== currentMission?.id);
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
    setCriteria("");
    setError(null);
  }, [latestTerminal?.id]);

  useEffect(() => {
    if (!departmentRecord || !onLoadThread) return;
    let current = true;
    setThreadLoading(true);
    void onLoadThread(departmentRecord.id).then((result) => {
      if (!current) return;
      setThreadLoading(false);
      if (result.data) setThreadPayload(result.data);
      else if (result.error) setError(result.error);
    });
    return () => { current = false; };
  }, [departmentRecord?.id, onLoadThread]);

  useEffect(() => {
    if (resetRequestKey <= 0 || handledResetRequest.current === resetRequestKey) return;
    handledResetRequest.current = resetRequestKey;
    void prepareSessionReset();
  }, [resetRequestKey]);

  // One composer for every continuation state. When the department has a
  // persistent thread, the department lead classifies the message itself
  // (question vs. new/follow-up work) — the owner never pre-selects a mode.
  // Without thread support (legacy departments), fall back to a safe
  // read-only ask when possible, then to starting a new Mission.
  async function continueWithDepartment(submission: CommandSubmission): Promise<string | null> {
    if (!submission.text.trim() && submission.images.length === 0 && submission.documents.length === 0) return "請輸入訊息或附加檔案";
    setWorking(true); setError(null);
    let result: string | null;
    if (departmentRecord && onMessageDepartment) {
      const response = await onMessageDepartment(
        departmentRecord.id,
        submission,
        criteria.split("\n").map((line) => line.trim()).filter(Boolean),
      );
      if (response.data) setThreadPayload(response.data);
      result = response.error ?? null;
    } else if (latestTerminal && onAsk) {
      result = await onAsk(latestTerminal.id, submission.text.trim());
    } else {
      result = await prepareAndStartDepartmentMission({
        bossWorkerId: boss.id,
        objective: latestTerminal
          ? `延續前次 Mission「${latestTerminal.objective}」的後續工作：${submission.text || "依附件執行後續工作"}`
          : submission.text || "依附加檔案完成交辦工作",
        acceptanceCriteria: criteria.split("\n").map((line) => line.trim()).filter(Boolean),
        images: submission.images,
        documents: submission.documents,
        clientMessageId: submission.clientMessageId,
        idempotencyKey: submission.idempotencyKey,
        parentMissionId: latestTerminal?.id,
      }, onPrepare, onStart);
    }
    setWorking(false);
    if (result) setError(result);
    else setCriteria("");
    return result;
  }

  async function action(run: () => Promise<string | null>) {
    setWorking(true); setError(null);
    const result = await run();
    setWorking(false);
    if (result) setError(result);
  }

  async function prepareSessionReset() {
    if (!departmentRecord || !onResetSessions) return;
    setWorking(true); setError(null); setResetResults(null);
    const result = await onResetSessions(departmentRecord.id, false);
    setWorking(false);
    if (result.error) setError(result.error);
    else setResetPreview(result.data?.members ?? []);
  }

  async function confirmSessionReset(workerIds?: string[]) {
    if (!departmentRecord || !onResetSessions) return;
    setWorking(true); setError(null);
    const result = await onResetSessions(departmentRecord.id, true, workerIds);
    setWorking(false);
    if (result.error) setError(result.error);
    else {
      setResetPreview(null);
      setResetResults(result.data?.results ?? []);
      if (result.data?.historyClearedAt && onLoadThread) {
        const refreshed = await onLoadThread(departmentRecord.id);
        if (refreshed.data) setThreadPayload(refreshed.data);
        else if (refreshed.error) setError(refreshed.error);
      }
    }
  }

  function renderMissionCard(mission: DepartmentMission) {
    const current = mission.currentStepIndex == null ? null : mission.steps[mission.currentStepIndex];
    const completed = mission.steps.filter((step) => step.status === "completed").length;
    const strategy = mission.steps[0]?.kind === "consult" ? "QUICK CONSULT" : mission.steps[0]?.kind === "review" ? "QUICK REVIEW" : "DEPARTMENT MISSION";
    const resolvedApprovalIds = new Set((mission.executionEvents ?? []).flatMap(({ event }) =>
      event.type === "approval_resolved" ? [event.id] : [],
    ));
    const pendingApprovals = (mission.executionEvents ?? []).flatMap(({ workerId, event }) =>
      event.type === "approval_requested" && !resolvedApprovalIds.has(event.request.id)
        ? [{ workerId, request: event.request }]
        : [],
    );
    const visibleActivity = (mission.executionEvents ?? [])
      .filter(({ event }) => !["text_delta", "thinking_delta", "tool_call_output_delta", "meta"].includes(event.type))
      .slice(-50);
    return <div key={mission.id} className="department-chat__exchange">
      <article className="department-chat__message department-chat__message--owner"><span>老闆</span><p>{mission.objective}</p></article>
      <article className={`mission-card mission-card--${mission.status}`}>
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
            {step.reviewResult.risks.length > 0 && <div><b>風險</b><ul>{step.reviewResult.risks.map((item, itemIndex) => <li key={`risk-${itemIndex}`}>{String(item)}</li>)}</ul></div>}
            {step.reviewResult.openQuestions.length > 0 && <div><b>未決問題</b><ul>{step.reviewResult.openQuestions.map((item, itemIndex) => <li key={`question-${itemIndex}`}>{String(item)}</li>)}</ul></div>}
            {step.reviewResult.recommendedNextAction && <p><b>建議：</b>{step.reviewResult.recommendedNextAction}</p>}
          </div>}
          {!step.reviewResult && step.result && <p>{step.result}</p>}
        </li>;
      })}</ol>}
      {pendingApprovals.length > 0 && <section className="mission-card__approvals" aria-label="任務等待核准">
        <h4>這項工作需要你的核准</h4>
        {pendingApprovals.map(({ workerId, request }) => {
          const worker = workers.find((candidate) => candidate.id === workerId);
          return <article key={request.id} className="mission-card__approval">
            <div><strong>{request.title}</strong><span>{worker?.name ?? "部門成員"} · {request.category}</span></div>
            {request.reason && <p>{request.reason}</p>}
            {request.command && <code>{request.command}</code>}
            <footer>
              <button type="button" disabled={working || !onResolveApproval} onClick={() => void action(() => onResolveApproval!(mission.id, request.id, "deny"))}>拒絕</button>
              <button type="button" disabled={working || !onResolveApproval} onClick={() => void action(() => onResolveApproval!(mission.id, request.id, "allow_once"))}>允許一次</button>
              {request.decisions.includes("allow_session") && <button type="button" disabled={working || !onResolveApproval} onClick={() => void action(() => onResolveApproval!(mission.id, request.id, "allow_session"))}>本次任務都允許</button>}
            </footer>
          </article>;
        })}
      </section>}
      {visibleActivity.length > 0 && <details className="mission-card__activity">
        <summary>任務執行紀錄 · {visibleActivity.length}</summary>
        <div className="mission-card__activity-list">
          {groupMissionActivity(visibleActivity).map((group) => {
            const workerName = workers.find((candidate) => candidate.id === group.workerId)?.name ?? "部門成員";
            if (group.kind === "tools") {
              return <div key={group.key} className="mission-activity-row">
                <span className="mission-activity-row__who">{workerName}</span>
                <div className="mission-activity-row__body">
                  {group.items.length > 1 ? <ToolGroup items={group.items} summary /> : <ToolRow item={group.items[0]} />}
                </div>
              </div>;
            }
            return <div key={group.key} className={`mission-activity-row mission-activity-row--${group.tone}`}>
              <span className="mission-activity-row__who">{workerName}</span>
              <span className="mission-activity-row__icon">{MISSION_ACTIVITY_TONE_ICON[group.tone]}</span>
              <span className="mission-activity-row__label">{group.label}</span>
            </div>;
          })}
        </div>
      </details>}
      {mission.error && <div className="handoff-dialog__error">{mission.error}</div>}
      {mission.status === "completed" && mission.steps.find((step) => step.kind === "synthesize")?.result && <section className="mission-card__final-report" aria-label="部門最終報告">
        <span>DEPARTMENT REPORT</span>
        <h4>部門最終報告</h4>
        <RichText text={mission.steps.find((step) => step.kind === "synthesize")!.result!} />
      </section>}
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
      </article>
    </div>;
  }

  const newMissionForm = <TaskComposer
    draftKey={`department:${departmentRecord?.id ?? boss.departmentId ?? boss.workspacePath}:${latestTerminal?.id ?? "new"}:work`}
    placeholder={latestTerminal ? "直接告訴部門要修改或接著完成什麼" : `直接交辦給 ${departmentRecord?.name ?? roomName(boss.workspacePath)}（可附加圖片或文件）`}
    submitLabel="交辦"
    busyLabel="派工中…"
    disabled={false}
    working={working}
    layout={composerHost ? "dock" : "inline"}
    focusMode={focusMode}
    leading={composerHost ? <span className="command-composer__target">部門</span> : undefined}
    toolbar={<>{latestTerminal && <div className="department-chat__reply-context"><span>延續</span><strong>{latestTerminal.objective}</strong></div>}<div className="department-chat__criteria"><details>
      <summary>＋ 驗收條件 <span>選填</span></summary>
      <div><small>每行一項，最多 8 項</small><textarea value={criteria} rows={4} placeholder={"例如：\n完整測試通過\n最後提交一份部門報告"} onChange={(event) => setCriteria(event.target.value)} /></div>
    </details></div>{department.length === 1 && <div className="department-chat__single" role="status">單人部門：可直接執行；不會安排獨立 Review。</div>}</>}
    onSubmit={continueWithDepartment}
  />;

  const content = <div className={`handoff-dialog__card mission-dialog__card ${embedded ? "mission-dialog__card--embedded" : ""} ${focusMode ? "mission-dialog__card--focus" : ""}`}>
      {!embedded && <button type="button" className="handoff-dialog__close" onClick={onClose} aria-label="關閉部門任務視窗">×</button>}
      <header className="department-chat__header">
        <div><span>DEPARTMENT CHAT · DIRECT EXECUTION</span><h2 id="mission-title">{departmentRecord?.name ?? roomName(boss.workspacePath)}</h2><p>已鎖定此部門；送出即授權部門依成員職務開始，由 {boss.name} 彙整回報。</p></div>
        <div className="department-chat__header-actions">
          <strong className={`department-chat__state ${activeMission ? "department-chat__state--active" : ""}`}>{activeMission ? statusLabel[activeMission.status] : "可直接交辦"}</strong>
          {departmentRecord && onResetSessions && <button type="button" className="department-chat__fresh" disabled={working} onClick={() => void prepareSessionReset()}>重開全員對話</button>}
        </div>
      </header>

      <details className="department-chat__team" open={focusSection === "team"}>
        <summary>{department.length} 位成員 · 查看職務</summary>
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
      </details>

      {!activeMission && !latestTerminal && <section className="department-chat__empty">
        <span aria-hidden="true">↗</span>
        <strong>直接告訴部門要完成什麼</strong>
        <p>不需要選模型或再次選部門。送出後，主管會依職務規劃、執行與驗收。</p>
      </section>}
      {error && <div className="handoff-dialog__error" role="alert">{error}</div>}
      {resetPreview && <section className="department-reset" role="alertdialog" aria-label="確認重開部門工作階段">
        <strong>為 {resetPreview.length} 位成員建立全新的 LLM 工作階段？</strong>
        <p>部門畫面上的舊對話與 Mission 會清空，NPC 也會改用全新的模型上下文；Boss 任務、Boss Mission 詳情、附件與稽核仍會保留。</p>
        <ul>{resetPreview.map((member) => <li key={member.workerId}>{member.name} · {member.provider}{member.model ? ` / ${member.model}` : ""}</li>)}</ul>
        <div><button type="button" onClick={() => setResetPreview(null)}>取消</button><button type="button" className="collaboration-dialog__primary" onClick={() => void confirmSessionReset()}>確認重開全部</button></div>
      </section>}
      {resetResults && <section className="department-reset department-reset--results" aria-label="工作階段重建結果">
        <strong>工作階段重建結果</strong>
        <ul>{resetResults.map((result) => <li key={result.workerId} className={result.ok ? "ok" : "failed"}>{result.name} · {result.ok ? "完成" : result.error || "失敗"}</li>)}</ul>
        {resetResults.some((result) => !result.ok) && <button type="button" onClick={() => void confirmSessionReset(resetResults.filter((result) => !result.ok).map((result) => result.workerId))}>只重試失敗成員</button>}
        <button type="button" onClick={() => setResetResults(null)}>關閉</button>
      </section>}

      <section className="department-thread" aria-label="部門對話紀錄">
        {threadLoading && <p className="department-thread__loading">正在讀取部門對話…</p>}
        {!threadLoading && threadPayload && threadPayload.messages.length === 0 && <p className="department-thread__loading">這個部門還沒有對話紀錄。</p>}
        {threadPayload?.messages.map((message) => {
          const messageAttachments = message.attachmentIds.flatMap((id) => {
            const attachment = threadPayload.attachments.find((candidate) => candidate.id === id);
            return attachment ? [attachment] : [];
          });
          return <article key={message.id} className={`department-thread__message department-thread__message--${message.role}`}>
            <header><strong>{message.role === "owner" ? "老闆" : message.role === "report" ? "部門最終報告" : departmentRecord?.name ?? boss.name}</strong><time>{new Date(message.createdAt).toLocaleString()}</time></header>
            <RichText text={message.text} compact={message.role !== "report"} />
            {messageAttachments.length > 0 && <ul className="department-thread__attachments">{messageAttachments.map((attachment) => <li key={attachment.id}>{attachment.kind === "image" ? "圖片" : "文件"} · {attachment.name}</li>)}</ul>}
            {message.role === "owner" && message.deliveryStatus === "pending" && <small>已保存，等待部門處理</small>}
          </article>;
        })}
      </section>

      {currentMission && <section className="mission-dialog__history">{renderMissionCard(currentMission)}</section>}
      {historicalMissions.length > 0 && <details className="mission-dialog__past-missions" open={focusSection === "history"}>
        <summary>此部門過往 Mission · {historicalMissions.length}</summary>
        {historicalMissions.map((mission) => renderMissionCard(mission))}
      </details>}
      {!activeMission && latestTerminal && <section className="department-continuation" aria-label="部門報告後續">
        <header>
          <div><span>CONTINUE WITH DEPARTMENT</span><strong>接著追問或交辦</strong></div>
        </header>
        <p>直接輸入即可：由 {boss.name} 判斷這是唯讀提問還是新的後續工作；需要新工作時會建立關聯的 Mission，原任務不會被更動。</p>
        {followUpTurns.length > 0 && <div className="department-continuation__thread">{followUpTurns.map((turn) => {
          const answer = turn.items.flatMap((item) => item.kind === "assistant_text" || item.kind === "system_error" ? [item.text] : []).join("\n").trim();
          return <article key={turn.key} className={`department-continuation__turn department-continuation__turn--${turn.status}`}>
            <div><span>你</span><p>{turn.command.replace(/^部門追問：/, "")}</p></div>
            <div><span>{boss.name}</span>{answer ? <RichText text={answer} compact /> : <p>{turn.status === "running" ? "主管正在整理報告脈絡…" : "這次追問沒有取得可讀回覆"}</p>}</div>
          </article>;
        })}</div>}
        {!composerHost && newMissionForm}
      </section>}
      {activeMission && <section className="department-running-composer" aria-label="進行中 Mission 對話">
        <p>可以繼續詢問、補充背景或提出修改；重大修改會在安全檢查點重新規劃。</p>
        {!composerHost && newMissionForm}
      </section>}
      {!activeMission && !latestTerminal && !composerHost && newMissionForm}
      {legacyRelated.length > 0 && <details className="mission-dialog__legacy">
        <summary>過往單次 NPC 協作 · {legacyRelated.length}</summary>
        {legacyRelated.map((task) => {
          const target = workers.find((worker) => worker.id === task.targetWorkerId);
          return <article key={task.id}><div><strong>{task.mode === "review" ? "Review" : "Consult"} · {target?.name ?? "未知 NPC"}</strong><span>{task.status}</span></div><p>{task.objective}</p>{task.result && <small>{task.result.verdict} · {task.result.summary}</small>}</article>;
        })}
      </details>}
    </div>;

  if (embedded) return <><section ref={dialogRef} className="mission-workspace" aria-labelledby="mission-title">{content}</section>{composerHost && createPortal(newMissionForm, composerHost)}</>;
  return <div ref={dialogRef} className="handoff-dialog mission-dialog" role="dialog" aria-modal="true" aria-labelledby="mission-title">{content}</div>;
}
