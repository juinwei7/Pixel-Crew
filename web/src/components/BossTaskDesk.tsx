import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { t } from "../i18n";
import type { AdvisorProposal, AdvisorResult, BossTask, BossTaskStage, CommandSubmission, DepartmentMission, ExecutionProfile, ProviderId, WorkerState } from "../types";
import { apiRequest } from "../api";
import { RichText } from "./RichText";
import { TaskComposer } from "./TaskComposer";
import { writeComposerDraft } from "../hooks/useComposerDraft";
import { type ConfirmTone } from "./ConfirmDialog";

type DecisionModelOption = { provider: ProviderId; model: string; label: string };

type Props = {
  workspacePath: string;
  tasks: BossTask[];
  missions?: DepartmentMission[];
  workers?: WorkerState[];
  decisionModels: DecisionModelOption[];
  onCreate(input: {
    message: string;
    acceptanceCriteria: string[];
    workspacePath: string;
    decisionProvider?: ProviderId;
    decisionModel?: string;
    executionProfile?: ExecutionProfile;
    maxAgents?: number;
    maxMissionSteps?: number;
    images?: CommandSubmission["images"];
    documents?: CommandSubmission["documents"];
    clientMessageId?: string;
    idempotencyKey?: string;
  }): Promise<{ data?: BossTask; error?: string }>;
  onMessage(id: string, submission: CommandSubmission): Promise<{ data?: BossTask; error?: string }>;
  onUpdate(id: string, patch: { title?: string; archived?: boolean }): Promise<{ data?: BossTask; error?: string }>;
  onDelete(id: string): Promise<{ error?: string }>;
  onRestart?(id: string, confirm: boolean): Promise<{ data?: { members?: Array<{ name: string }>; missions?: Array<{ objective: string }>; bossTask?: BossTask }; error?: string }>;
  onOpenMission?(missionId: string): void;
  onCreateDepartment?(): void;
  onClose(): void;
  composerHost?: Element | null;
  focusMode?: boolean;
  confirm(message: string, tone?: ConfirmTone): Promise<boolean>;
};

const statusLabel: Record<BossTask["status"], string> = {
  discovering: t("探索需求"),
  ready: t("準備派工"),
  running: t("跨部門執行中"),
  needs_input: t("等待老闆補充"),
  needs_attention: t("需要老闆處理"),
  synthesizing: t("彙整報告"),
  completed: t("已完成"),
  failed: t("未完成"),
  cancelled: t("已取消"),
};

const starterTasks = [
  "規劃並開發一套簡易 ERP",
  "整理上週營運數據並提出建議",
  "檢查目前產品並安排改善計畫",
];

const LAST_BOSS_TASK_KEY = "pixel-crew:boss-last-task";
const terminalStatuses: BossTask["status"][] = ["completed", "failed", "cancelled"];

function workspaceLabel(path: string): string {
  return path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path;
}

export function bossStageProgress(stage: BossTaskStage, mission: DepartmentMission | undefined, workers: WorkerState[] = []): string {
  if (!mission) {
    if (stage.status === "completed") return t("已完成");
    if (stage.status === "failed") return t("失敗");
    if (stage.status === "cancelled") return t("已取消");
    return stage.dependsOn.length > 0 ? t("等待前一階段") : t("等待啟動");
  }
  if (mission.status === "planning") return t("規劃中");
  if (mission.status === "reviewing") return t("審核交付中");
  if (mission.status === "needs_attention") return t("等待你決定");
  if (mission.status === "completed") return t("已完成");
  if (mission.status === "failed") return t("失敗");
  if (mission.status === "cancelled") return t("已取消");
  const currentIndex = mission.currentStepIndex;
  const step = currentIndex == null ? null : mission.steps[currentIndex];
  if (!step) return t("執行中");
  const assignee = workers.find((worker) => worker.id === step.assigneeWorkerId)?.name;
  return t("第 {current}/{total} 步：{title}{assignee}", {
    current: (currentIndex ?? 0) + 1,
    total: mission.steps.length || 1,
    title: step.title,
    assignee: assignee ? ` · ${assignee}` : "",
  });
}

export function BossTaskDesk({ workspacePath, tasks, missions = [], workers = [], decisionModels, onCreate, onMessage, onUpdate, onDelete, onRestart, onOpenMission, onCreateDepartment, onClose, composerHost, focusMode = false, confirm }: Props) {
  const ordered = useMemo(
    () => [...tasks].sort((a, b) => Number(Boolean(a.archivedAt)) - Number(Boolean(b.archivedAt)) || b.updatedAt.localeCompare(a.updatedAt)),
    [tasks],
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [newTask, setNewTask] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [managing, setManaging] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [criteria, setCriteria] = useState("");
  const [decisionKey, setDecisionKey] = useState("");
  const [executionProfile, setExecutionProfile] = useState<ExecutionProfile>("standard");
  const [maxAgents, setMaxAgents] = useState(4);
  const [maxMissionSteps, setMaxMissionSteps] = useState(3);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 專家顧問（沒方向時的前段）：一個粗略念頭 → 幾個「你可能沒想到」的方向 → 挑一個
  // 就把它的 objective 預填進下面的交辦草稿（沿用 starterTasks 同款「填草稿＋重開」）。
  const [advisorIdea, setAdvisorIdea] = useState("");
  const [advisorLoading, setAdvisorLoading] = useState(false);
  const [advisorError, setAdvisorError] = useState<string | null>(null);
  const [advisorDomain, setAdvisorDomain] = useState<string | null>(null);
  const [advisorQuestion, setAdvisorQuestion] = useState<string | null>(null);
  const [advisorProposals, setAdvisorProposals] = useState<AdvisorProposal[]>([]);
  // 顧問生成一次要 ~100–115 秒（冷啟＋思考＋4 段內容）：期間跑一個計時＋輪播訊息的動畫，
  // 讓使用者知道還活著、大概還要多久，而不是對著一個不動的按鈕乾等。
  const [advisorElapsed, setAdvisorElapsed] = useState(0);
  // 交辦顧問方向時，用這個 seed 強制 TaskComposer 重掛，讓它重新從 localStorage 讀進 objective
  // ——因為沒有既有任務時 draftKey 前後相同、composer 不會自己重讀（就是「點了沒反應／再點消失」的根因）。
  const [composerSeed, setComposerSeed] = useState(0);
  const restoredSelection = useRef(false);

  useEffect(() => {
    if (!advisorLoading) return;
    setAdvisorElapsed(0);
    const started = performance.now();
    const timer = window.setInterval(() => {
      setAdvisorElapsed(Math.floor((performance.now() - started) / 1000));
    }, 250);
    return () => window.clearInterval(timer);
  }, [advisorLoading]);

  // 依已過秒數輪播「顧問正在做什麼」的擬真階段訊息（純視覺，不代表真實後端步驟）。
  const advisorPhases = [
    t("正在讀你的工作區脈絡…"),
    t("在推敲這屬於哪個領域…"),
    t("搜尋你可能沒想到的專業方向…"),
    t("為每個方向補內行洞見與實作路數…"),
    t("整理成可直接交辦的方向…"),
  ];
  const advisorPhase = advisorPhases[Math.min(advisorPhases.length - 1, Math.floor(advisorElapsed / 24))];
  const advisorProgress = Math.min(96, Math.round((advisorElapsed / 110) * 100));

  const runAdvisor = async (proactive = false) => {
    const idea = advisorIdea.trim();
    // proactive（主動建議）時不需要念頭；一般模式仍要有念頭。
    if ((!idea && !proactive) || advisorLoading) return;
    setAdvisorLoading(true);
    setAdvisorError(null);
    setAdvisorProposals([]);
    setAdvisorQuestion(null);
    setAdvisorDomain(null);
    const decision = decisionModels.find((option) => `${option.provider}:${option.model}` === decisionKey);
    try {
      const data = await apiRequest<{ result: AdvisorResult }>("/api/advisor/propose", {
        method: "POST",
        body: { idea, workspacePath, provider: decision?.provider, model: decision?.model, proactive },
        // 生成方向較慢（冷啟＋思考＋4 段內容），逾時要比 server 的 150s 長，否則前端先斷。
        timeoutMs: 160_000,
      });
      if (data.result.status === "need_focus") {
        setAdvisorQuestion(data.result.question);
      } else {
        setAdvisorProposals(data.result.proposals);
        setAdvisorDomain(data.result.domain || null);
      }
    } catch (advisorFailure) {
      setAdvisorError((advisorFailure as Error).message);
    } finally {
      setAdvisorLoading(false);
    }
  };

  // 把選中的方向 objective 預填進「新任務」草稿並重開 composer（與 starterTasks 一致）。
  const useProposalObjective = (objective: string) => {
    // 目標一律進「新任務」草稿：切到新任務、清掉選取，再把 objective 寫進該 draftKey，
    // 然後 bump seed 逼 composer 重掛重讀（換 key 前寫入，避免舊實例的 200ms 自動存檔把它蓋回空）。
    setShowArchived(false);
    setSelectedId(null);
    setNewTask(true);
    writeComposerDraft(`boss:${workspacePath}:new`, objective);
    setComposerSeed((seed) => seed + 1);
  };
  // Mirrors the `tasks` prop for the re-check in deleteRecord — confirm() is
  // non-blocking, so a WS-driven status change can land while its dialog is
  // still open; re-read through this ref instead of a stale closure.
  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;
  const activeTasks = ordered.filter((task) => !task.archivedAt);
  const archivedTasks = ordered.filter((task) => task.archivedAt);
  const visibleTasks = showArchived ? archivedTasks : activeTasks;
  const selected = visibleTasks.find((task) => task.id === selectedId) ?? (!newTask ? visibleTasks[0] : undefined);

  useEffect(() => {
    if (!restoredSelection.current && ordered.length > 0) {
      restoredSelection.current = true;
      let saved = "";
      try { saved = localStorage.getItem(LAST_BOSS_TASK_KEY) ?? ""; } catch { /* unavailable */ }
      const savedTask = ordered.find((task) => task.id === saved);
      if (savedTask) {
        setShowArchived(Boolean(savedTask.archivedAt));
        setSelectedId(savedTask.id);
        return;
      }
    }
    if (newTask || selectedId && visibleTasks.some((task) => task.id === selectedId)) return;
    setSelectedId(visibleTasks[0]?.id ?? null);
  }, [newTask, ordered, selectedId, showArchived, visibleTasks]);

  useEffect(() => {
    if (!selected?.id) return;
    try { localStorage.setItem(LAST_BOSS_TASK_KEY, selected.id); } catch { /* unavailable */ }
  }, [selected?.id]);

  useEffect(() => {
    setTitleDraft(selected?.title ?? "");
    setManaging(false);
  }, [selected?.id, selected?.title]);

  useEffect(() => {
    const modelKey = `pixel-crew:boss-decision-model:${workspacePath}`;
    try {
      const savedModel = localStorage.getItem(modelKey) ?? "";
      setDecisionKey(decisionModels.some((option) => `${option.provider}:${option.model}` === savedModel) ? savedModel : "");
    } catch {
      setDecisionKey("");
    }
  }, [decisionModels, selected?.id, workspacePath]);

  async function submit(submission: CommandSubmission): Promise<string | null> {
    const text = submission.text.trim();
    if ((!text && submission.images.length === 0 && submission.documents.length === 0) || working) return t("請輸入任務或加入附件");
    setWorking(true);
    setError(null);
    let result: { data?: BossTask; error?: string };
    if (selected && !newTask) {
      result = await onMessage(selected.id, submission);
    } else {
      const decision = decisionModels.find((option) => `${option.provider}:${option.model}` === decisionKey);
      result = await onCreate({
        message: text || "請依附加檔案規劃並完成任務",
        acceptanceCriteria: criteria.split("\n").map((line) => line.trim()).filter(Boolean).slice(0, 8),
        workspacePath,
        decisionProvider: decision?.provider,
        decisionModel: decision?.model,
        executionProfile,
        maxAgents,
        maxMissionSteps,
        images: submission.images,
        documents: submission.documents,
        clientMessageId: submission.clientMessageId,
        idempotencyKey: submission.idempotencyKey,
      });
    }
    setWorking(false);
    if (result.error || !result.data) {
      const message = result.error || t("無法送出 Boss Task");
      setError(message);
      return message;
    }
    setCriteria("");
    setSelectedId(result.data.id);
    setNewTask(false);
    setShowArchived(false);
    return null;
  }

  async function updateRecord(patch: { title?: string; archived?: boolean }) {
    if (!selected || working) return;
    setWorking(true);
    setError(null);
    const result = await onUpdate(selected.id, patch);
    setWorking(false);
    if (result.error || !result.data) {
      setError(result.error || t("無法更新任務記錄"));
      return;
    }
    if (patch.archived === true) {
      setShowArchived(false);
      setSelectedId(activeTasks.find((task) => task.id !== selected.id)?.id ?? null);
    } else if (patch.archived === false) {
      setShowArchived(false);
      setSelectedId(result.data.id);
    }
    setManaging(false);
  }

  async function deleteRecord() {
    if (!selected || working || !terminalStatuses.includes(selected.status)) return;
    if (!(await confirm(t("確定永久刪除 Boss 任務「{title}」？此動作無法復原。", { title: selected.title }), "danger"))) return;
    // Re-check against the latest tasks — confirm() doesn't block the page,
    // so a WS push could have moved this task out of a terminal status while
    // the dialog was open.
    const current = tasksRef.current.find((task) => task.id === selected.id);
    if (!current || !terminalStatuses.includes(current.status)) {
      setError(t("這筆任務狀態已變更，無法刪除。"));
      return;
    }
    setWorking(true);
    setError(null);
    const result = await onDelete(selected.id);
    setWorking(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    setManaging(false);
    setShowArchived(false);
    setSelectedId(activeTasks.find((task) => task.id !== selected.id)?.id ?? null);
  }

  async function restartTask() {
    if (!selected || !onRestart || working) return;
    setWorking(true); setError(null);
    const preview = await onRestart(selected.id, false);
    setWorking(false);
    if (preview.error) { setError(preview.error); return; }
    const missionCount = preview.data?.missions?.length ?? 0;
    const memberNames = preview.data?.members?.map((member) => member.name).join("、") || t("相關 NPC");
    if (!(await confirm(t("清空這個 Boss 交辦並重新規劃？將取消 {count} 個進行中的 Mission，並重開：{members}。附件與稽核紀錄會保留。", { count: missionCount, members: memberNames }), "danger"))) return;
    setWorking(true); setError(null);
    const committed = await onRestart(selected.id, true);
    setWorking(false);
    if (committed.error) setError(committed.error);
  }

  const canReply = selected && ["needs_input", "needs_attention", "completed", "failed"].includes(selected.status);
  const placeholder = !selected || newTask
    ? t("直接交辦你想做的工作，例如：我要上週業績報告")
    : selected.status === "needs_input"
      ? t("直接回答決策模型的問題")
      : selected.status === "needs_attention"
        ? t("補充指示或重試；若部門 Mission 中斷，請開啟對應階段處理")
      : selected.status === "completed" || selected.status === "failed"
        ? t("追問結果、要求修改，或追加後續工作")
        : t("目前正在跨部門執行；進度會自動回報");

  const composer = <TaskComposer
    key={`boss-composer-${composerSeed}`}
    draftKey={`boss:${selected && !newTask ? selected.id : `${workspacePath}:new`}`}
    placeholder={placeholder}
    submitLabel={selected && !newTask ? t("送出") : t("交辦")}
    busyLabel={t("處理中…")}
    disabled={Boolean(selected && !newTask && !canReply)}
    working={working}
    layout={composerHost ? "dock" : "inline"}
    focusMode={focusMode}
    leading={composerHost ? <span className="command-composer__target">BOSS</span> : undefined}
    toolbar={(!selected || newTask) && <div className="boss-task-composer__setup">
      <details><summary>{t("執行邊界與估算")} <span>{t("開始前設定")}</span></summary><div><label><span>{t("執行級別")}</span><select value={executionProfile} onChange={(event) => {
        const profile = event.target.value as ExecutionProfile;
        setExecutionProfile(profile);
        if (profile === "quick") { setMaxAgents(2); setMaxMissionSteps(2); }
        else if (profile === "deep") { setMaxAgents(6); setMaxMissionSteps(4); }
        else { setMaxAgents(4); setMaxMissionSteps(3); }
      }}>
        <option value="quick">{t("快速 · 最少協作")}</option>
        <option value="standard">{t("標準 · 平衡範圍")}</option>
        <option value="deep">{t("深度 · 複雜任務")}</option>
      </select></label><label><span>{t("最多 NPC")}</span><input type="number" min={1} max={executionProfile === "quick" ? 2 : executionProfile === "deep" ? 6 : 4} value={maxAgents} onChange={(event) => setMaxAgents(Number(event.target.value))} /></label><label><span>{t("每 Mission 最多步驟")}</span><input type="number" min={2} max={executionProfile === "quick" ? 2 : executionProfile === "deep" ? 4 : 3} value={maxMissionSteps} onChange={(event) => setMaxMissionSteps(Number(event.target.value))} /></label><small>{executionProfile === "quick"
        ? t("上限：2 位 NPC、1 個部門階段、每 Mission 2 步；約 2–10 分鐘。")
        : executionProfile === "deep"
          ? t("上限：6 位 NPC、5 個部門階段、每 Mission 4 步；約 30–90 分鐘。")
          : t("上限：4 位 NPC、3 個部門階段、每 Mission 3 步；約 10–35 分鐘。")}</small><small>{t("預估：Claude 約 US$ 0.02–2.00；Codex 約影響 5 小時 quota 1–30%。實際依工作內容與模型而變，非保證值；超過上限會停止派工，不會靜默擴張。")}</small></div></details>
      <details><summary>{t("進階設定")} <span>{t("選填")}</span></summary><div><label><span>{t("決策模型")}</span><select value={decisionKey} onChange={(event) => {
        setDecisionKey(event.target.value);
        try { localStorage.setItem(`pixel-crew:boss-decision-model:${workspacePath}`, event.target.value); } catch { /* unavailable */ }
      }}>
        <option value="">{t("自動選擇 Claude / Codex")}</option>
        {decisionModels.map((option) => <option key={`${option.provider}:${option.model}`} value={`${option.provider}:${option.model}`}>{option.label}</option>)}
      </select></label></div></details>
      <details><summary>{t("驗收條件")} <span>{t("選填")}</span></summary><div><strong>{t("完成的標準")}</strong><small>{t("每行一項，最多 8 項")}</small><textarea value={criteria} rows={4} onChange={(event) => setCriteria(event.target.value)} placeholder={t("例如：\n可建立客戶與訂單\n具備權限控管\n測試全部通過")} /></div></details>
    </div>}
    onSubmit={submit}
  />;

  return <>
  <section className="boss-task-desk" aria-labelledby="boss-task-title">
    <header className="boss-task-desk__header">
      <div><span>BOSS DESK · TASK LOG</span><h2 id="boss-task-title">{t("老闆任務日誌")}</h2></div>
      <div className="boss-task-desk__controls">
        {visibleTasks.length > 0 && <select aria-label={t("選擇 Boss Task")} value={newTask ? "" : selected?.id ?? ""} onChange={(event) => {
          if (!event.target.value) { setNewTask(true); setShowArchived(false); setSelectedId(null); }
          else { setNewTask(false); setSelectedId(event.target.value); }
        }}>
          <option value="">{t("＋ 新任務")}</option>
          {visibleTasks.map((task) => <option key={task.id} value={task.id}>{task.title.slice(0, 34)} · {workspaceLabel(task.workspacePath)} · {statusLabel[task.status]}</option>)}
        </select>}
        {archivedTasks.length > 0 && <button type="button" className={showArchived ? "active" : ""} onClick={() => {
          const next = !showArchived;
          setShowArchived(next);
          setNewTask(false);
          setSelectedId((next ? archivedTasks : activeTasks)[0]?.id ?? null);
        }}>{showArchived ? t("目前任務") : t("封存 {count}", { count: archivedTasks.length })}</button>}
        <button type="button" onClick={() => { setNewTask(true); setShowArchived(false); setSelectedId(null); setError(null); }}>{t("＋ 新任務")}</button>
        {selected && !newTask && <button type="button" className={managing ? "active" : ""} onClick={() => setManaging((value) => !value)}>{t("整理")}</button>}
        <button type="button" onClick={onClose} aria-label={t("關閉老闆任務日誌")}>×</button>
      </div>
    </header>

    {managing && selected && !newTask && <section className="boss-task-record-editor" aria-label={t("整理任務記錄")}>
      <label><span>{t("記錄標題")}</span><input value={titleDraft} maxLength={120} onChange={(event) => setTitleDraft(event.target.value)} onKeyDown={(event) => {
        if (event.key === "Enter" && titleDraft.trim() && titleDraft.trim() !== selected.title) void updateRecord({ title: titleDraft.trim() });
      }} /></label>
      <div>
        <button type="button" disabled={working || !titleDraft.trim() || titleDraft.trim() === selected.title} onClick={() => void updateRecord({ title: titleDraft.trim() })}>{t("儲存名稱")}</button>
        {selected.archivedAt
          ? <button type="button" disabled={working} onClick={() => void updateRecord({ archived: false })}>{t("移回目前任務")}</button>
          : <button type="button" disabled={working || !terminalStatuses.includes(selected.status)} title={terminalStatuses.includes(selected.status) ? t("保留完整歷史並從目前清單移除") : t("進行中或等待處理的任務不能封存")} onClick={() => void updateRecord({ archived: true })}>{t("封存記錄")}</button>}
        <button type="button" className="boss-task-record-editor__delete" disabled={working || !terminalStatuses.includes(selected.status)} title={terminalStatuses.includes(selected.status) ? t("永久刪除這筆 Boss 任務記錄") : t("進行中或等待處理的任務不能刪除")} onClick={() => void deleteRecord()}>{t("刪除紀錄")}</button>
      </div>
      <small>{selected.archivedAt ? t("封存於 {time}", { time: new Date(selected.archivedAt).toLocaleString() }) : terminalStatuses.includes(selected.status) ? t("封存會保留全部對話、部門階段與報告。") : t("這筆任務仍在進行或等待處理，完成／取消後才能封存。")}</small>
    </section>}

    <div className="boss-task-desk__scroll">
      {!selected || newTask ? <div className="boss-task-desk__empty">
        <div className="boss-task-desk__empty-mark" aria-hidden="true">B</div>
        <span>BOSS DESK</span>
        <strong>{t("今天想完成什麼？")}</strong>
        <p>{t("將以目前工作區「{workspace}」開始；需求太概略時會先詢問，明確後才安排部門。", { workspace: workspaceLabel(workspacePath) })}</p>
        <div className="boss-task-desk__starters" aria-label={t("任務範例")}>
          {starterTasks.map((starter) => <button key={starter} type="button" onClick={() => useProposalObjective(t(starter))}>{t(starter)}</button>)}
        </div>
        {onCreateDepartment && <button type="button" className="boss-task-desk__new-department" onClick={onCreateDepartment}>
          <span className="boss-task-desk__new-department-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24"><circle cx="8" cy="8" r="2.5" /><circle cx="16" cy="8" r="2.5" /><path d="M3.5 18c.4-3 1.9-4.7 4.5-4.7s4.1 1.7 4.5 4.7M11.5 18c.4-3 1.9-4.7 4.5-4.7s4.1 1.7 4.5 4.7" /></svg>
          </span>
          <span className="boss-task-desk__new-department-text">
            <strong>{t("建立專門處理的部門")}</strong>
            <small>{t("成立一支常駐團隊長期負責某個領域，之後交辦會自動路由給它。")}</small>
          </span>
          <span className="boss-task-desk__new-department-arrow" aria-hidden="true">→</span>
        </button>}
        <div className="boss-task-desk__advisor" aria-label={t("專家顧問")}>
          <div className="boss-task-desk__advisor-head">
            <strong>{t("沒方向？讓顧問幫你想")}</strong>
            <small>{t("給一個粗略念頭或主題，顧問會用專業列出你可能沒想到的方向，挑一個就能交辦。")}</small>
          </div>
          <div className="boss-task-desk__advisor-input">
            <input
              value={advisorIdea}
              onChange={(event) => setAdvisorIdea(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void runAdvisor(); } }}
              placeholder={t("例如：我想用 AI 做量化交易，但不知道從何下手")}
              maxLength={4000}
              aria-label={t("你的粗略念頭或主題")}
            />
            <button type="button" onClick={() => void runAdvisor()} disabled={advisorLoading || !advisorIdea.trim()}>
              {advisorLoading ? t("顧問思考中…") : t("幫我想方向")}
            </button>
          </div>
          {/* 主動建議：完全沒想法時，讓顧問從你的工作區脈絡主動端幾個方向給你挑（只建議、不自動執行）。 */}
          <button
            type="button"
            className="boss-task-desk__advisor-proactive"
            onClick={() => void runAdvisor(true)}
            disabled={advisorLoading}
          >
            {advisorLoading ? t("顧問思考中…") : t("完全沒想法？讓顧問主動給我建議")}
          </button>
          {advisorLoading && <div className="boss-task-desk__advisor-loading" role="status" aria-live="polite">
            <div className="boss-task-desk__advisor-orb"><span></span><span></span><span></span></div>
            <div className="boss-task-desk__advisor-loading-body">
              <strong>{t("顧問思考中…")}</strong>
              <span key={advisorPhase} className="boss-task-desk__advisor-phase">{advisorPhase}</span>
              <div className="boss-task-desk__advisor-bar"><i style={{ width: `${advisorProgress}%` }}></i></div>
              <small>{t("已思考 {sec} 秒 · 通常約 100–115 秒，請稍候", { sec: advisorElapsed })}</small>
            </div>
          </div>}
          {advisorError && <p className="boss-task-desk__advisor-error" role="alert">{advisorError}</p>}
          {advisorQuestion && <div className="boss-task-desk__advisor-question">
            <strong>{t("顧問想先確認一件事：")}</strong>
            <p>{advisorQuestion}</p>
            <small>{t("把答案補進上面的念頭，再按一次「幫我想方向」。")}</small>
          </div>}
          {advisorProposals.length > 0 && <div className="boss-task-desk__advisor-proposals">
            {advisorDomain && <small className="boss-task-desk__advisor-domain">{t("領域：{domain}", { domain: advisorDomain })}</small>}
            {advisorProposals.map((proposal) => (
              <div key={proposal.id} className="boss-task-desk__advisor-card">
                <strong>{proposal.title}</strong>
                {proposal.summary && <p>{proposal.summary}</p>}
                {proposal.insight && <p className="boss-task-desk__advisor-insight">{proposal.insight}</p>}
                {proposal.approach && <p className="boss-task-desk__advisor-approach">{proposal.approach}</p>}
                {proposal.considerations.length > 0 && <ul>{proposal.considerations.map((item, index) => <li key={index}>{item}</li>)}</ul>}
                <button type="button" onClick={() => useProposalObjective(proposal.objective)}>{t("用這個方向交辦 →")}</button>
              </div>
            ))}
          </div>}
        </div>
      </div> : <>
        <div className={`boss-task-desk__status boss-task-desk__status--${selected.status}`}>
          <span>{selected.executionMode === "research" && selected.status === "running" ? t("快速研究中") : statusLabel[selected.status]}</span>
          <small>{selected.decisionProvider} · {selected.decisionModel}</small>
        </div>
        {selected.executionBudget && <p className="boss-task-desk__budget">{t("{profile}邊界 · 最多 {agents} 位 NPC / {stages} 階段 / 每 Mission {steps} 步 · 預估 {min}–{max} 分鐘", {
          profile: selected.executionBudget.label, agents: selected.executionBudget.maxAgents, stages: selected.executionBudget.maxStages,
          steps: selected.executionBudget.maxMissionSteps, min: selected.executionBudget.estimatedDurationMinutes.min, max: selected.executionBudget.estimatedDurationMinutes.max,
        })}</p>}
        {selected.stages.length > 0 && <p className="boss-task-stages__progress">{t("已完成 {completed}/{total} 個部門階段", {
          completed: selected.stages.filter((stage) => (stage.missionId ? missions.find((mission) => mission.id === stage.missionId)?.status : stage.status) === "completed").length,
          total: selected.stages.length,
        })}</p>}
        <div className="boss-task-desk__messages">
          {selected.messages.map((entry) => <article key={entry.id} className={`boss-task-message boss-task-message--${entry.role}`}>
            <span>{entry.role === "boss" ? t("老闆") : entry.role === "decision_model" ? t("決策模型") : entry.role === "report" ? t("最終報告") : "Pixel Crew"}</span>
            <div className="boss-task-message__content">
              <RichText text={entry.text} compact={entry.role !== "report"} />
              {(entry.attachmentIds?.length ?? 0) > 0 && <small>{t("附件 {count} 個", { count: entry.attachmentIds!.length })}</small>}
            </div>
          </article>)}
        </div>
        {selected.stages.length > 0 && <div className="boss-task-stages">
          <h3>{selected.executionMode === "research" ? t("部門快速研究") : t("跨部門執行")}</h3>
          {selected.stages.map((stage, index) => <button key={stage.id} type="button" disabled={!stage.missionId || !onOpenMission} onClick={() => stage.missionId && onOpenMission?.(stage.missionId)}>
            <i>{index + 1}</i><span><strong>{stage.departmentName} · {stage.title}</strong><small>{bossStageProgress(stage, stage.missionId ? missions.find((mission) => mission.id === stage.missionId) : undefined, workers)}</small></span>
          </button>)}
        </div>}
        {onRestart && !selected.archivedAt && <button type="button" className="boss-task-desk__restart" disabled={working || selected.status === "discovering" || selected.status === "synthesizing"} onClick={() => void restartTask()}>{t("清空並重新交辦")}</button>}
      </>}
    </div>

    {!composerHost && <footer className="boss-task-composer">
      {composer}
      {error && <div className="boss-task-composer__error" role="alert">{error}</div>}
    </footer>}
    {composerHost && error && <div className="boss-task-composer__error boss-task-composer__error--panel" role="alert">{error}</div>}
  </section>
  {composerHost && createPortal(composer, composerHost)}
  </>;
}
