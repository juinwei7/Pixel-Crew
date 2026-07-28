import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { BossTask, CommandSubmission, ProviderId } from "../types";
import { RichText } from "./RichText";
import { TaskComposer } from "./TaskComposer";

type DecisionModelOption = { provider: ProviderId; model: string; label: string };

type Props = {
  workspacePath: string;
  tasks: BossTask[];
  decisionModels: DecisionModelOption[];
  onCreate(input: {
    message: string;
    acceptanceCriteria: string[];
    workspacePath: string;
    decisionProvider?: ProviderId;
    decisionModel?: string;
    images?: CommandSubmission["images"];
    documents?: CommandSubmission["documents"];
    clientMessageId?: string;
    idempotencyKey?: string;
  }): Promise<{ data?: BossTask; error?: string }>;
  onMessage(id: string, submission: CommandSubmission): Promise<{ data?: BossTask; error?: string }>;
  onUpdate(id: string, patch: { title?: string; archived?: boolean }): Promise<{ data?: BossTask; error?: string }>;
  onDelete(id: string): Promise<{ error?: string }>;
  onOpenMission?(missionId: string): void;
  onClose(): void;
  composerHost?: Element | null;
  focusMode?: boolean;
};

const statusLabel: Record<BossTask["status"], string> = {
  discovering: "探索需求",
  ready: "準備派工",
  running: "跨部門執行中",
  needs_input: "等待老闆補充",
  needs_attention: "需要老闆處理",
  synthesizing: "彙整報告",
  completed: "已完成",
  failed: "未完成",
  cancelled: "已取消",
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

export function BossTaskDesk({ workspacePath, tasks, decisionModels, onCreate, onMessage, onUpdate, onDelete, onOpenMission, onClose, composerHost, focusMode = false }: Props) {
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
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const restoredSelection = useRef(false);
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
    if ((!text && submission.images.length === 0 && submission.documents.length === 0) || working) return "請輸入任務或加入附件";
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
        images: submission.images,
        documents: submission.documents,
        clientMessageId: submission.clientMessageId,
        idempotencyKey: submission.idempotencyKey,
      });
    }
    setWorking(false);
    if (result.error || !result.data) {
      const message = result.error || "無法送出 Boss Task";
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
      setError(result.error || "無法更新任務記錄");
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
    if (!window.confirm(`確定永久刪除 Boss 任務「${selected.title}」？此動作無法復原。`)) return;
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

  const canReply = selected && ["needs_input", "needs_attention", "completed", "failed"].includes(selected.status);
  const placeholder = !selected || newTask
    ? "直接交辦你想做的工作，例如：我要上週業績報告"
    : selected.status === "needs_input"
      ? "直接回答決策模型的問題"
      : selected.status === "needs_attention"
        ? "補充指示或重試；若部門 Mission 中斷，請開啟對應階段處理"
      : selected.status === "completed" || selected.status === "failed"
        ? "追問結果、要求修改，或追加後續工作"
        : "目前正在跨部門執行；進度會自動回報";

  const composer = <TaskComposer
    draftKey={`boss:${selected && !newTask ? selected.id : `${workspacePath}:new`}`}
    placeholder={placeholder}
    submitLabel={selected && !newTask ? "送出" : "交辦"}
    busyLabel="處理中…"
    disabled={Boolean(selected && !newTask && !canReply)}
    working={working}
    layout={composerHost ? "dock" : "inline"}
    focusMode={focusMode}
    leading={composerHost ? <span className="command-composer__target">BOSS</span> : undefined}
    toolbar={(!selected || newTask) && <div className="boss-task-composer__setup">
      <details><summary>進階設定 <span>選填</span></summary><div><label><span>決策模型</span><select value={decisionKey} onChange={(event) => {
        setDecisionKey(event.target.value);
        try { localStorage.setItem(`pixel-crew:boss-decision-model:${workspacePath}`, event.target.value); } catch { /* unavailable */ }
      }}>
        <option value="">自動選擇 Claude / Codex</option>
        {decisionModels.map((option) => <option key={`${option.provider}:${option.model}`} value={`${option.provider}:${option.model}`}>{option.label}</option>)}
      </select></label></div></details>
      <details><summary>驗收條件 <span>選填</span></summary><div><strong>完成的標準</strong><small>每行一項，最多 8 項</small><textarea value={criteria} rows={4} onChange={(event) => setCriteria(event.target.value)} placeholder={"例如：\n可建立客戶與訂單\n具備權限控管\n測試全部通過"} /></div></details>
    </div>}
    onSubmit={submit}
  />;

  return <>
  <section className="boss-task-desk" aria-labelledby="boss-task-title">
    <header className="boss-task-desk__header">
      <div><span>BOSS DESK · TASK LOG</span><h2 id="boss-task-title">老闆任務日誌</h2></div>
      <div className="boss-task-desk__controls">
        {visibleTasks.length > 0 && <select aria-label="選擇 Boss Task" value={newTask ? "" : selected?.id ?? ""} onChange={(event) => {
          if (!event.target.value) { setNewTask(true); setShowArchived(false); setSelectedId(null); }
          else { setNewTask(false); setSelectedId(event.target.value); }
        }}>
          <option value="">＋ 新任務</option>
          {visibleTasks.map((task) => <option key={task.id} value={task.id}>{task.title.slice(0, 34)} · {workspaceLabel(task.workspacePath)} · {statusLabel[task.status]}</option>)}
        </select>}
        {archivedTasks.length > 0 && <button type="button" className={showArchived ? "active" : ""} onClick={() => {
          const next = !showArchived;
          setShowArchived(next);
          setNewTask(false);
          setSelectedId((next ? archivedTasks : activeTasks)[0]?.id ?? null);
        }}>{showArchived ? "目前任務" : `封存 ${archivedTasks.length}`}</button>}
        <button type="button" onClick={() => { setNewTask(true); setShowArchived(false); setSelectedId(null); setError(null); }}>＋ 新任務</button>
        {selected && !newTask && <button type="button" className={managing ? "active" : ""} onClick={() => setManaging((value) => !value)}>整理</button>}
        <button type="button" onClick={onClose} aria-label="關閉老闆任務日誌">×</button>
      </div>
    </header>

    {managing && selected && !newTask && <section className="boss-task-record-editor" aria-label="整理任務記錄">
      <label><span>記錄標題</span><input value={titleDraft} maxLength={120} onChange={(event) => setTitleDraft(event.target.value)} onKeyDown={(event) => {
        if (event.key === "Enter" && titleDraft.trim() && titleDraft.trim() !== selected.title) void updateRecord({ title: titleDraft.trim() });
      }} /></label>
      <div>
        <button type="button" disabled={working || !titleDraft.trim() || titleDraft.trim() === selected.title} onClick={() => void updateRecord({ title: titleDraft.trim() })}>儲存名稱</button>
        {selected.archivedAt
          ? <button type="button" disabled={working} onClick={() => void updateRecord({ archived: false })}>移回目前任務</button>
          : <button type="button" disabled={working || !terminalStatuses.includes(selected.status)} title={terminalStatuses.includes(selected.status) ? "保留完整歷史並從目前清單移除" : "進行中或等待處理的任務不能封存"} onClick={() => void updateRecord({ archived: true })}>封存記錄</button>}
        <button type="button" className="boss-task-record-editor__delete" disabled={working || !terminalStatuses.includes(selected.status)} title={terminalStatuses.includes(selected.status) ? "永久刪除這筆 Boss 任務記錄" : "進行中或等待處理的任務不能刪除"} onClick={() => void deleteRecord()}>刪除紀錄</button>
      </div>
      <small>{selected.archivedAt ? `封存於 ${new Date(selected.archivedAt).toLocaleString()}` : terminalStatuses.includes(selected.status) ? "封存會保留全部對話、部門階段與報告。" : "這筆任務仍在進行或等待處理，完成／取消後才能封存。"}</small>
    </section>}

    <div className="boss-task-desk__scroll">
      {!selected || newTask ? <div className="boss-task-desk__empty">
        <div className="boss-task-desk__empty-mark" aria-hidden="true">B</div>
        <span>BOSS DESK</span>
        <strong>今天想完成什麼？</strong>
        <p>將以目前工作區「{workspaceLabel(workspacePath)}」開始；需求太概略時會先詢問，明確後才安排部門。</p>
        <div className="boss-task-desk__starters" aria-label="任務範例">
          {starterTasks.map((starter) => <button key={starter} type="button" onClick={() => {
            try { localStorage.setItem(`pixel-crew:task-composer:boss:${workspacePath}:new`, starter); } catch { /* unavailable */ }
            setNewTask(false);
            requestAnimationFrame(() => setNewTask(true));
          }}>{starter}</button>)}
        </div>
      </div> : <>
        <div className={`boss-task-desk__status boss-task-desk__status--${selected.status}`}>
          <span>{selected.executionMode === "research" && selected.status === "running" ? "快速研究中" : statusLabel[selected.status]}</span>
          <small>{selected.decisionProvider} · {selected.decisionModel}</small>
        </div>
        <div className="boss-task-desk__messages">
          {selected.messages.map((entry) => <article key={entry.id} className={`boss-task-message boss-task-message--${entry.role}`}>
            <span>{entry.role === "boss" ? "老闆" : entry.role === "decision_model" ? "決策模型" : entry.role === "report" ? "最終報告" : "Pixel Crew"}</span>
            <div className="boss-task-message__content">
              <RichText text={entry.text} compact={entry.role !== "report"} />
              {(entry.attachmentIds?.length ?? 0) > 0 && <small>附件 {entry.attachmentIds!.length} 個</small>}
            </div>
          </article>)}
        </div>
        {selected.stages.length > 0 && <div className="boss-task-stages">
          <h3>{selected.executionMode === "research" ? "部門快速研究" : "跨部門執行"}</h3>
          {selected.stages.map((stage, index) => <button key={stage.id} type="button" disabled={!stage.missionId || !onOpenMission} onClick={() => stage.missionId && onOpenMission?.(stage.missionId)}>
            <i>{index + 1}</i><span><strong>{stage.departmentName} · {stage.title}</strong><small>{stage.status}</small></span>
          </button>)}
        </div>}
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
