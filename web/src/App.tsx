import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useWorkers } from "./hooks/useWorkers";
import { topDismissibleLayer, useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import { useUiPreferences, clampTaskLogWidth, clampTaskLogHeight, isTaskLogVisible, shouldAutoCollapseTaskLog } from "./uiPreferences";
import { GameCanvas } from "./components/GameCanvas";
import { QuestLog } from "./components/QuestLog";
import { WorkerTabs } from "./components/WorkerTabs";
import { TopBar } from "./components/TopBar";
import { TaskComposer } from "./components/TaskComposer";
import { ToastRegion, type Toast } from "./components/ToastRegion";
import { EnergyHud, FocusEnergy } from "./components/EnergyHud";
import { AuthGate } from "./components/AuthGate";
import { WorkspacePicker } from "./components/WorkspacePicker";
import { DepartmentMissionDialog } from "./components/DepartmentMissionDialog";
import { BossTaskDesk } from "./components/BossTaskDesk";
import { FocusControls } from "./components/FocusControls";
import { FocusStudios } from "./components/FocusStudios";
import { FocusPaneGrid } from "./components/FocusPaneGrid";
import { ModelSwitchCard } from "./components/ModelSwitchCard";
import { Modal } from "./components/Modal";
import { hasSeenTour } from "./onboardingState";
import { Office3D } from "./components/Office3D";
import { RichText } from "./components/RichText";
import { requiresAutoApproveConfirmation } from "./autoApproveSafety";
import { theme } from "./theme";
import { parseMcpToolName } from "./mcpToolName";
import { discussionSubmission, toggleDiscussionMode, type DiscussionMode } from "./discussionMode";
import { roundtablePrompt } from "./roundtablePrompt";
import { apiRequest } from "./api";
import { t } from "./i18n";
import type { ApprovalDecision, WorkerState } from "./types";

type WarRoomAction = { priority: "P1" | "P2" | "P3" | "P4"; title: string; how: string };
type WarRoomDispute = { point: string; ruling: string };
type WarRoomMetric = { label: string; value: string; note?: string };
type WarRoomChart = { type: "line" | "bar" | "donut"; title: string; labels: string[]; values: number[]; unit?: string };
type WarRoomResult = { verdict: string; consensus: string[]; disputes: WarRoomDispute[]; actions: WarRoomAction[]; metrics?: WarRoomMetric[]; charts?: WarRoomChart[]; structured: boolean; costUsd?: number };

// 手工 SVG 圖表：走勢(line)/長條(bar)/圓餅(donut)。不引圖表庫——輕量、跟介面同一套深色霓虹風。
const CHART_COLORS = ["#00e5ff", "#ffb000", "#00ffa3", "#ff2e88", "#a855ff", "#93a5ba"];

function WarroomChartView({ chart }: { chart: WarRoomChart }) {
  const { type, labels, values, unit } = chart;
  const fmt = (v: number) => `${Number.isInteger(v) ? v.toLocaleString() : v.toLocaleString(undefined, { maximumFractionDigits: 2 })}${unit ?? ""}`;

  if (type === "donut") {
    const total = values.reduce((sum, v) => sum + Math.abs(v), 0) || 1;
    const R = 34, C = 2 * Math.PI * R;
    let acc = 0;
    return <div className="warroom-chart">
      <h4>{chart.title}</h4>
      <div className="warroom-chart__donut">
        <svg viewBox="0 0 100 100" width="96" height="96">
          {values.map((v, i) => {
            const frac = Math.abs(v) / total;
            const dash = frac * C;
            const el = <circle key={i} cx="50" cy="50" r={R} fill="none" stroke={CHART_COLORS[i % CHART_COLORS.length]}
              strokeWidth="13" strokeDasharray={`${dash} ${C - dash}`} strokeDashoffset={-acc * C}
              transform="rotate(-90 50 50)" />;
            acc += frac;
            return el;
          })}
        </svg>
        <ul>{labels.map((l, i) => <li key={i}><i style={{ background: CHART_COLORS[i % CHART_COLORS.length] }} />{l} <b>{fmt(values[i])}</b><em>{Math.round(Math.abs(values[i]) / total * 100)}%</em></li>)}</ul>
      </div>
    </div>;
  }

  const W = 280, H = 110, padX = 8, padTop = 16, padBottom = 22;
  const vmax = Math.max(...values, 0), vmin = Math.min(...values, 0);
  const span = vmax - vmin || 1;
  const y = (v: number) => padTop + (vmax - v) / span * (H - padTop - padBottom);
  const zeroY = y(0);

  if (type === "bar") {
    const bw = Math.min(28, (W - padX * 2) / values.length * 0.62);
    const step = (W - padX * 2) / values.length;
    return <div className="warroom-chart">
      <h4>{chart.title}</h4>
      <svg viewBox={`0 0 ${W} ${H}`} className="warroom-chart__svg">
        <line x1={padX} y1={zeroY} x2={W - padX} y2={zeroY} stroke="rgba(147,165,186,.35)" strokeWidth="1" />
        {values.map((v, i) => {
          const x = padX + step * i + (step - bw) / 2;
          const top = Math.min(y(v), zeroY), h = Math.max(2, Math.abs(y(v) - zeroY));
          const color = v >= 0 ? "#00e5ff" : "#ff2e88";
          return <g key={i}>
            <rect x={x} y={top} width={bw} height={h} rx="2" fill={color} opacity="0.85" />
            <text x={x + bw / 2} y={top - 3} textAnchor="middle" fontSize="7.5" fill="#cfdbea">{fmt(v)}</text>
            <text x={x + bw / 2} y={H - 8} textAnchor="middle" fontSize="7.5" fill="#7d93ab">{labels[i]?.slice(0, 6)}</text>
          </g>;
        })}
      </svg>
    </div>;
  }

  // line：折線＋漸層面積＋端點數值
  const step = (W - padX * 2) / Math.max(1, values.length - 1);
  const pts = values.map((v, i) => [padX + step * i, y(v)] as const);
  const poly = pts.map(([px, py]) => `${px},${py}`).join(" ");
  const area = `${padX},${H - padBottom} ${poly} ${W - padX},${H - padBottom}`;
  const up = values[values.length - 1] >= values[0];
  const lineColor = up ? "#00ffa3" : "#ff2e88";
  return <div className="warroom-chart">
    <h4>{chart.title}</h4>
    <svg viewBox={`0 0 ${W} ${H}`} className="warroom-chart__svg">
      <polygon points={area} fill={lineColor} opacity="0.1" />
      <polyline points={poly} fill="none" stroke={lineColor} strokeWidth="1.8" strokeLinejoin="round" />
      {pts.map(([px, py], i) => <circle key={i} cx={px} cy={py} r="2" fill={lineColor} />)}
      <text x={pts[0][0]} y={pts[0][1] - 5} fontSize="7.5" fill="#cfdbea">{fmt(values[0])}</text>
      <text x={pts[pts.length - 1][0]} y={pts[pts.length - 1][1] - 5} textAnchor="end" fontSize="7.5" fill="#cfdbea">{fmt(values[values.length - 1])}</text>
      <text x={padX} y={H - 8} fontSize="7.5" fill="#7d93ab">{labels[0]}</text>
      <text x={W - padX} y={H - 8} textAnchor="end" fontSize="7.5" fill="#7d93ab">{labels[labels.length - 1]}</text>
    </svg>
  </div>;
}

// 裁決內容的共用渲染：結束彈窗與 📜歷史都用這一份，保證兩邊長得一模一樣。
// 最上方是「關鍵數字」數據磚——用數字說話，不讓數據埋在文字裡。
function WarroomVerdictBody({ result }: { result: WarRoomResult }) {
  const metrics = result.metrics ?? [];
  const charts = result.charts ?? [];
  return <>
    {metrics.length > 0 && <div className="warroom-metrics">{metrics.map((m, i) => (
      <div key={i} className="warroom-metric" style={{ "--i": i } as React.CSSProperties}>
        <small>{m.label}</small>
        <strong>{m.value}</strong>
        {m.note && <em className={m.note.trim().startsWith("-") ? "is-down" : m.note.trim().startsWith("+") ? "is-up" : ""}>{m.note}</em>}
      </div>
    ))}</div>}
    {charts.length > 0 && <div className="warroom-charts">{charts.map((c, i) => <WarroomChartView key={i} chart={c} />)}</div>}
    <p className="warroom-result__verdict">{result.verdict}</p>
    {result.consensus.length > 0 && <section><h3>{t("✅ 共識")}</h3><ul>{result.consensus.map((c, i) => <li key={i}>{c}</li>)}</ul></section>}
    {result.disputes.length > 0 && <section><h3>{t("⚖️ 分歧與裁決")}</h3><ul>{result.disputes.map((d, i) => <li key={i}><strong>{d.point}</strong> → {d.ruling}</li>)}</ul></section>}
    {result.actions.length > 0 && <section><h3>{t("➡️ 可執行下一步")}</h3><ol>{result.actions.map((a, i) => <li key={i}><span className={`warroom-result__prio warroom-result__prio--${a.priority}`}>{a.priority}</span> <strong>{a.title}</strong>{a.how && <small>{a.how}</small>}</li>)}</ol></section>}
    {!result.structured && <p className="warroom-result__note">{t("（NPC 未回傳結構化格式，以上為原始裁決文字）")}</p>}
  </>;
}
import { diffNotifications, snapshotWorker, type WorkerSnapshot } from "./notifications";
import { latestReadableTurnKey, workerAttention, workerFocusStatus, workerHasUnread } from "./crew";
import { buildFocusStudios, focusStudioWorkers, studioWorkerId } from "./focusStudios";
import { addPane, createFocusPanes, MAX_FOCUS_PANES, removePane, setPaneWorker, type FocusPane } from "./focusPanes";
import type { AutoApproveMode, ProviderId } from "./types";

const CommandCenter = lazy(() => import("./components/CommandCenter").then((module) => ({
  default: module.CommandCenter,
})));
// These dialogs are all opened by an explicit user action. Keeping them out of
// the first-load graph makes the office usable sooner without changing any
// interaction once a dialog is requested.
const AvatarWorkshop = lazy(() => import("./components/AvatarWorkshop").then((module) => ({ default: module.AvatarWorkshop })));
const ProviderHandoffDialog = lazy(() => import("./components/ProviderHandoffDialog").then((module) => ({ default: module.ProviderHandoffDialog })));
const PersonaEditor = lazy(() => import("./components/PersonaEditor").then((module) => ({ default: module.PersonaEditor })));
const DepartmentCreator = lazy(() => import("./components/DepartmentCreator").then((module) => ({ default: module.DepartmentCreator })));
const McpModal = lazy(() => import("./components/McpModal").then((module) => ({ default: module.McpModal })));
const CodexCommandsModal = lazy(() => import("./components/CodexCommandsModal").then((module) => ({ default: module.CodexCommandsModal })));
const AccountsModal = lazy(() => import("./components/AccountsModal").then((module) => ({ default: module.AccountsModal })));
const BackupModal = lazy(() => import("./components/BackupModal").then((module) => ({ default: module.BackupModal })));
const OpsModal = lazy(() => import("./components/OpsModal").then((module) => ({ default: module.OpsModal })));
const RemoteAccessModal = lazy(() => import("./components/RemoteAccessModal").then((module) => ({ default: module.RemoteAccessModal })));
const KanbanModal = lazy(() => import("./components/KanbanModal").then((module) => ({ default: module.KanbanModal })));
const DayReportModal = lazy(() => import("./components/DayReportModal").then((module) => ({ default: module.DayReportModal })));
const OutboxModal = lazy(() => import("./components/OutboxModal").then((module) => ({ default: module.OutboxModal })));
const ShortcutsHelp = lazy(() => import("./components/ShortcutsHelp").then((module) => ({ default: module.ShortcutsHelp })));
const OnboardingTour = lazy(() => import("./components/OnboardingTour").then((module) => ({ default: module.OnboardingTour })));

const CLAUDE_MODEL_OPTIONS = [
  { id: "opus", label: "Opus" },
  { id: "sonnet", label: "Sonnet" },
  { id: "haiku", label: t("Haiku（最快）") },
  { id: "fable", label: "Fable" },
];

function mergeModelOptions(fallback: typeof CLAUDE_MODEL_OPTIONS, discovered: typeof CLAUDE_MODEL_OPTIONS, activeModel?: string | null) {
  const models = new Map<string, { id: string; label: string; description?: string }>();
  for (const model of fallback) models.set(model.id, model);
  for (const model of discovered) models.set(model.id, model);
  if (activeModel && !models.has(activeModel)) models.set(activeModel, { id: activeModel, label: activeModel });
  return [{ id: "", label: t("預設模型") }, ...models.values()];
}

const EMPTY_CAPABILITIES = {
  slashCommands: [], mcpServers: [], models: [], toolCount: null, builtinTools: null, loading: true,
  source: "empty" as const, updatedAt: null, error: null,
};

export function App() {
  const {
    workers, bossTasks, collaborations, missions, departments, order, mcpLoginResult, activeId, setActiveId, targetRepoPath, system, stats, updateInfo, workspacePaths, wsReady,
    capabilitiesByWorkspace, workflowRevisions, auth, providerUsage, providerInstalls, accounts, accountLogins, defaultCodexLogin, defaultClaudeLogin, createAccount, deleteAccount, refreshAccount, startAccountLogin, submitAccountLoginCode, cancelAccountLogin, startDefaultCodexLogin, cancelDefaultCodexLogin, startDefaultClaudeLogin, submitDefaultClaudeLoginCode, cancelDefaultClaudeLogin, setWorkerAccount, createWorker, pickWorkspace,
    switchWorkspace, closeWorker, renameWorker, reorderWorkers, saveAvatar, resetAvatar, selectAvatarPreset, activateCustomAvatar, prepareHandoff, startHandoff, switchProviderFresh,
    prepareMission, startMission, loadDepartmentThread, messageDepartment, resetDepartmentSessions, renameDepartment, createBossTask, messageBossTask, updateBossTask, deleteBossTask, cancelMission, retryMissionReview, approveMissionPlan, resolveMission,
    send, askMission, setModel, setModelFresh, setPersona, setAutoApproveMode, interrupt, resolveApproval, resolveMissionApproval, refreshAuth, refreshUsage, installProvider,
  } = useWorkers();
  const { preferences, updatePreferences, resetPreferences } = useUiPreferences();
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [workspaceMode, setWorkspaceMode] = useState<"create" | "move">("move");
  const [newWorkerProvider, setNewWorkerProvider] = useState<ProviderId>("claude");
  const [newWorkerAccountId, setNewWorkerAccountId] = useState<string | null>(null);
  const [commandCenterOpen, setCommandCenterOpen] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  // 快速圓桌＝目前 NPC 單回合模擬多視角；作戰室＝2–4 個短命 Claude 同儕真的辯論。
  // 兩者刻意分成不同入口，讓時間、Provider 與用量預期不會混在一起。
  const [discussionMode, setDiscussionMode] = useState<DiscussionMode>(null);
  // 目前正在「開作戰室」的 NPC id 清單，拿來在畫面上讓那位 NPC 冒出討論中的對話泡
  // （沿用場景既有的 speech bubble，不用另寫 pixi 動畫）。roundtableSeenBusy 用來避免競態：
  // 剛送出時 worker 還沒變 busy，要等它「忙過又變回閒置」才算討論結束、才清掉旗標。
  const [roundtableWorkerIds, setRoundtableWorkerIds] = useState<string[]>([]);
  const roundtableSeenBusy = useRef<Set<string>>(new Set());
  // 作戰室使用短命 NPC；結束後由後端自動拆除，不污染常駐 NPC。
  const roundtableTempIdRef = useRef<string | null>(null);
  const [warroomResult, setWarroomResult] = useState<WarRoomResult | null>(null);
  const [warroomRunning, setWarroomRunning] = useState(false);
  // 作戰室歷史面板：列出 .warroom/ 的過往裁決報告，可回看/刪除（null＝面板關閉）。
  const [warroomHistory, setWarroomHistory] = useState<Array<{ file: string; topic: string; difficulty: string }> | null>(null);
  const [warroomHistoryContent, setWarroomHistoryContent] = useState<{ file: string; content: string; report?: { topic?: string; difficulty?: string; result?: WarRoomResult } | null } | null>(null);
  // 輸入框輪播小撇步：閒置時輪流提示隱藏功能（點會議桌、⚙ 自訂角色…），幫助發現功能。
  const composerTips = [
    t("點底部會議桌可直接開作戰室"),
    t("⚙ 可自訂作戰室上桌角色"),
    t("📜 歷史能回看每場裁決（含圖表）"),
    t("作戰室會依難度自動配模型與人數"),
  ];
  const [tipIndex, setTipIndex] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTipIndex((index) => (index + 1) % composerTips.length), 8_000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ⚙ 自訂作戰室角色：每行「角色名｜立場描述」，存 localStorage；空白＝用預設（依難度自動配）。
  // （曾有過使用者可按的「🔍研究」按鈕，後拆除：委派是 host NPC（大腦）的工具——使用者直接
  //   跟 NPC 講就好，由它決定要不要呼叫 /api/delegate 派研究員，按鈕只是繞過大腦的冗餘入口。）
  const [stancesOpen, setStancesOpen] = useState(false);
  const [stancesText, setStancesText] = useState(() => localStorage.getItem("warroom-stances") ?? "");
  // 作戰室「⋯」更多選項選單：自訂角色／歷史是多 Agent 辯論的子設定與回顧。
  const [roundtableMenuOpen, setRoundtableMenuOpen] = useState(false);
  const roundtableMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!roundtableMenuOpen) return;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") setRoundtableMenuOpen(false); };
    const closeOutside = (event: PointerEvent) => {
      if (!roundtableMenuRef.current?.contains(event.target as Node)) setRoundtableMenuOpen(false);
    };
    window.addEventListener("keydown", close);
    // 捕獲階段：像素/3D 辦公室畫布會在冒泡階段吃掉 pointerdown，冒泡監聽收不到點擊。
    window.addEventListener("pointerdown", closeOutside, true);
    return () => {
      window.removeEventListener("keydown", close);
      window.removeEventListener("pointerdown", closeOutside, true);
    };
  }, [roundtableMenuOpen]);

  function parseCustomStances(text: string): Array<{ name: string; brief: string }> {
    return text.split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [name, ...rest] = line.split(/[｜|]/);
        return { name: (name ?? "").trim().slice(0, 12), brief: rest.join("｜").trim().slice(0, 200) };
      })
      .filter((s) => s.name)
      .slice(0, 4);
  }

  async function openWarroomHistory() {
    try {
      const resp = await apiRequest<{ ok: boolean; reports: Array<{ file: string; topic: string; difficulty: string }> }>(
        `/api/warroom/history?workspacePath=${encodeURIComponent(activeWorkspace)}`);
      setWarroomHistory(resp.reports);
      setWarroomHistoryContent(null);
    } catch (error) {
      notify(error instanceof Error ? error.message : t("讀取歷史失敗"), "error");
    }
  }
  const [shortcutsHelpOpen, setShortcutsHelpOpen] = useState(false);
  const [avatarWorkerId, setAvatarWorkerId] = useState<string | null>(null);
  const [handoffTarget, setHandoffTarget] = useState<ProviderId | null>(null);
  const [selectedDepartmentId, setSelectedDepartmentId] = useState<string | null>(null);
  const [bossMissionDetailId, setBossMissionDetailId] = useState<string | null>(null);
  const [departmentFocusSection, setDepartmentFocusSection] = useState<"team" | "history" | null>(null);
  const [providerChanging, setProviderChanging] = useState(false);
  const [personaWorkerId, setPersonaWorkerId] = useState<string | null>(null);
  const [departmentCreatorOpen, setDepartmentCreatorOpen] = useState(false);
  const [mcpModalOpen, setMcpModalOpen] = useState(false);
  const [codexCommandsModalOpen, setCodexCommandsModalOpen] = useState(false);
  const [accountsModalOpen, setAccountsModalOpen] = useState(false);
  const [opsModalOpen, setOpsModalOpen] = useState(false);
  const [remoteModalOpen, setRemoteModalOpen] = useState(false);
  const [kanbanModalOpen, setKanbanModalOpen] = useState(false);
  const [dayReportOpen, setDayReportOpen] = useState(false);
  const [outboxOpen, setOutboxOpen] = useState(false);
  // 首次進站自動播新手導覽；之後從頂欄 ❓ 重看。開導覽時順手展開任務面板，讓對應步驟有東西可指
  const [tourOpen, setTourOpen] = useState(() => !hasSeenTour());
  const openTour = () => { updatePreferences({ taskLogOpen: true }); setTourOpen(true); };
  // BOSS 桌從頂欄與看板空狀態兩處進入，開法保持一致。
  const openBossDesk = () => { setBossAssignmentOpen(true); setSelectedDepartmentId(null); setBossMissionDetailId(null); setTaskSearchOpen(false); updatePreferences({ taskLogOpen: true }); };
  const [restartPending, setRestartPending] = useState(false);
  // 重啟完成後 WebSocket 會斷線再重連;重連成功就把 pending 徽章收掉
  useEffect(() => { if (wsReady) setRestartPending(false); }, [wsReady]);
  const [backupModalOpen, setBackupModalOpen] = useState(false);
  const [bossAssignmentOpen, setBossAssignmentOpen] = useState(false);
  const [pendingModelSwitch, setPendingModelSwitch] = useState<{ workerId: string; model: string } | null>(null);
  const [pendingAutoApproveMode, setPendingAutoApproveMode] = useState<{
    workerId: string;
    workerName: string;
    workspacePath: string;
    mode: AutoApproveMode;
  } | null>(null);
  const [modelSwitchSubmitting, setModelSwitchSubmitting] = useState(false);
  const [taskSearchOpen, setTaskSearchOpen] = useState(false);
  const [taskSearch, setTaskSearch] = useState("");
  const [taskSearchScope, setTaskSearchScope] = useState<"current" | "all">("current");
  const taskFocusMode = preferences.taskFocusMode;
  const [focusUsageOpen, setFocusUsageOpen] = useState(false);
  const [focusSeenTurns, setFocusSeenTurns] = useState<Record<string, string | null>>({});
  // Split-pane workbench state: which NPC each pane shows and which pane
  // currently receives keyboard input / rail selections. Only meaningful
  // while taskFocusMode is on; a single pane behaves exactly like the
  // pre-split-pane single-worker reader.
  const [focusWorkbench, setFocusWorkbench] = useState<{ panes: FocusPane[]; focusedPaneId: string }>(() => {
    const panes = createFocusPanes(1);
    return { panes, focusedPaneId: panes[0].id };
  });
  const focusPanes = focusWorkbench.panes;
  const focusedPaneId = focusWorkbench.focusedPaneId;
  const [composerFocusRequest, setComposerFocusRequest] = useState(0);
  const [composerHost, setComposerHost] = useState<HTMLDivElement | null>(null);
  const setComposerHostRef = useCallback((node: HTMLDivElement | null) => setComposerHost(node), []);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  const focusLayerRef = useRef<HTMLDivElement>(null);
  const focusExitRef = useRef<HTMLButtonElement>(null);
  const focusReturnRef = useRef<HTMLElement | null>(null);

  // 這幾個清單以前每次 render 都用 .map / Object.values 重算一份新陣列，害得吃它們的重量級子元件
  // （尤其 GameCanvas）內部那個 useEffect([workers, collaborations, missions, departments]) 每次 render
  // 都以為資料變了，就重跑 visualWorkers() 並呼叫 pixi setWorkers()，造成畫面持續無謂重算。改用 useMemo
  // 讓「內容沒變時陣列參照就不變」，這些效果只在真的有變動時才觸發。
  const workerList = useMemo(() => order.map((id) => workers[id]).filter(Boolean), [order, workers]);
  const collaborationList = useMemo(() => Object.values(collaborations), [collaborations]);
  const missionList = useMemo(() => Object.values(missions), [missions]);
  const departmentList = useMemo(() => Object.values(departments), [departments]);
  // 臨時作戰室 NPC 忙過又變回閒置＝討論結束，把它頭上的討論氣泡旗標清掉；
  // 還沒開始忙的先留著，避免剛送出就被清。
  useEffect(() => {
    if (roundtableWorkerIds.length === 0) return;
    const seen = roundtableSeenBusy.current;
    const stillActive: string[] = [];
    for (const id of roundtableWorkerIds) {
      const busy = Boolean(workers[id]?.busy);
      if (busy) { seen.add(id); stillActive.push(id); }
      else if (seen.has(id)) { seen.delete(id); } // 忙過又閒置 → 結束，移除旗標
      else stillActive.push(id); // 還沒開始忙，先留著
    }
    if (stillActive.length !== roundtableWorkerIds.length) setRoundtableWorkerIds(stillActive);
  }, [workers, roundtableWorkerIds]);
  const roundtableIdSet = useMemo(() => new Set(roundtableWorkerIds), [roundtableWorkerIds]);
  const active = activeId ? workers[activeId] : undefined;
  const selectedDepartment = selectedDepartmentId ? departments[selectedDepartmentId] : undefined;
  const selectedDepartmentLead = selectedDepartment
    ? workers[selectedDepartment.leadWorkerId] ?? selectedDepartment.memberWorkerIds.map((id) => workers[id]).find(Boolean)
    : undefined;
  const activeProvider: ProviderId = active?.provider ?? "claude";
  const activeWorkspace = active?.workspacePath || targetRepoPath;
  const activeSessionKey = `${activeId ?? "none"}:${activeProvider}:${activeWorkspace}`;
  const workspaceSetupRequired = Boolean(system?.workspaceSetupRequired && workerList.length === 0);
  const activeAuth = auth[activeProvider];
  const activeCapabilities = capabilitiesByWorkspace[activeWorkspace]?.[activeProvider] ?? EMPTY_CAPABILITIES;
  const modelOptions = mergeModelOptions(
    activeProvider === "claude" ? CLAUDE_MODEL_OPTIONS : [],
    activeCapabilities.models,
    active?.model,
  );
  // 專注模式需要顯示真正的模型：未覆寫的 NPC 取 server 讀到的本機 provider
  // 預設值，而非含混的「預設模型」。
  function focusModelLabel(worker: WorkerState): string {
    const catalog = [
      ...(worker.provider === "claude" ? CLAUDE_MODEL_OPTIONS : []),
      ...(capabilitiesByWorkspace[worker.workspacePath]?.[worker.provider]?.models ?? []),
    ];
    return worker.model
      ? catalog.find((candidate) => candidate.id === worker.model)?.label ?? worker.model
      : system?.providerDefaultModels?.[worker.provider] ?? t("預設模型");
  }

  function focusWorkerLabel(worker: WorkerState, unread = false): string {
    const model = focusModelLabel(worker);
    return `${unread ? "● " : ""}${worker.name} · ${worker.provider === "claude" ? "Claude" : "Codex"} · ${model} · ${workerFocusStatus(worker)}`;
  }
  const decisionModelOptions = useMemo(() => {
    const options = new Map<string, { provider: ProviderId; model: string; label: string }>();
    for (const provider of ["claude", "codex"] as const) {
      if (auth[provider].status !== "authenticated") continue;
      const discovered = capabilitiesByWorkspace[activeWorkspace]?.[provider]?.models ?? [];
      const configured = Object.values(workers)
        .filter((worker) => worker.workspacePath === activeWorkspace && worker.provider === provider && worker.model)
        .map((worker) => ({ id: worker.model!, label: worker.model! }));
      const catalog = provider === "claude" ? [...CLAUDE_MODEL_OPTIONS, ...discovered, ...configured] : [...discovered, ...configured];
      for (const model of catalog) {
        if (!model.id) continue;
        const key = `${provider}:${model.id}`;
        if (!options.has(key)) options.set(key, {
          provider,
          model: model.id,
          label: `${provider === "claude" ? "Claude" : "Codex"} · ${model.label}`,
        });
      }
    }
    return [...options.values()];
  }, [activeWorkspace, auth, capabilitiesByWorkspace, workers]);
  const usedMcpTools = useMemo(() => {
    const map: Record<string, Set<string>> = {};
    for (const worker of workerList) {
      if (worker.workspacePath !== activeWorkspace || worker.provider !== activeProvider) continue;
      for (const turn of worker.turns) {
        for (const item of turn.items) {
          if (item.kind !== "tool_call") continue;
          const { label, mcpServer } = parseMcpToolName(item.name);
          if (!mcpServer) continue;
          (map[mcpServer] ??= new Set()).add(label);
        }
      }
    }
    return Object.fromEntries(Object.entries(map).map(([key, value]) => [key, [...value]]));
  }, [workerList, activeWorkspace, activeProvider]);
  const taskLogTurns = useMemo(() => {
    if (taskSearchScope === "current" || !taskSearch.trim()) return active?.turns ?? [];
    return workerList.flatMap((worker) => worker.turns.map((turn) => ({
      ...turn,
      key: `${worker.id}:${turn.key}`,
      command: `${worker.name} · ${turn.command}`,
    })));
  }, [active?.turns, taskSearch, taskSearchScope, workerList]);
  const focusStudios = useMemo(() => buildFocusStudios(workspacePaths, workerList.map((worker) => {
    const attention = workerAttention(worker);
    return {
      id: worker.id,
      name: worker.name,
      workspacePath: worker.workspacePath,
      busy: worker.busy,
      needsAttention: attention === "approval" || attention === "error",
      unread: worker.id !== activeId && workerHasUnread(worker, focusSeenTurns[worker.id] ?? undefined),
    };
  })), [activeId, focusSeenTurns, workerList, workspacePaths]);
  const focusWorkspaceWorkers = useMemo(() => focusStudioWorkers(workerList, activeWorkspace), [activeWorkspace, workerList]);
  const focusStudioDepartmentGroups = useMemo(() => Object.values(departments).map((department) => ({
    department,
    workers: focusWorkspaceWorkers.filter((worker) => worker.departmentId === department.id),
  })).filter((group) => group.workers.length > 0), [departments, focusWorkspaceWorkers]);
  const focusStudioStandaloneWorkers = useMemo(() => focusWorkspaceWorkers.filter((worker) => !worker.departmentId || !departments[worker.departmentId]), [departments, focusWorkspaceWorkers]);

  const dismissToast = useCallback((id: string) => setToasts((current) => current.filter((toast) => toast.id !== id)), []);
  const notify = useCallback((message: string, tone: Toast["tone"] = "ok") => {
    setToasts((current) => [...current.slice(-3), { id: `${Date.now()}-${Math.random()}`, message, tone }]);
  }, []);

  // A successful restart deliberately drops WebSocket and this state clears on
  // reconnect. If the detached launcher cannot start, though, the server stays
  // online; poll its small status endpoint so the menu never remains locked.
  useEffect(() => {
    if (!restartPending) return;
    let cancelled = false;
    const check = async () => {
      try {
        const status = await apiRequest<{ pending: boolean; error: string | null }>("/api/restart-server/status");
        if (cancelled || status.pending) return;
        setRestartPending(false);
        if (status.error) notify(status.error, "error");
      } catch {
        // The expected successful path briefly takes the server offline.
      }
    };
    void check();
    const timer = window.setInterval(() => { void check(); }, 3_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [notify, restartPending]);

  const activateNpc = useCallback((id: string) => {
    const worker = workers[id];
    const remembered = worker ? { ...preferences.focusStudioLastWorkerIds, [worker.workspacePath]: id } : preferences.focusStudioLastWorkerIds;
    setActiveId(id);
    setSelectedDepartmentId(null);
    setBossMissionDetailId(null);
    setBossAssignmentOpen(false);
    // 點任何 NPC＝回去跟他聊天，討論模式自動關閉（點會議桌才會再開作戰室）。
    // 這樣「桌子＝開會、人＝聊天」的空間直覺才一致，不會忘了關模式把普通問題丟去討論。
    setDiscussionMode(null);
    updatePreferences({ taskLogOpen: true, focusStudioLastWorkerIds: remembered });
    setComposerFocusRequest((request) => request + 1);
  }, [preferences.focusStudioLastWorkerIds, setActiveId, updatePreferences, workers]);

  // Assigning a worker to a pane always focuses that pane too — picking an
  // NPC for pane 2 should let you type to it immediately, without a second
  // click. With a single pane this degenerates to today's plain "select NPC".
  const assignWorkerToPane = useCallback((paneId: string, workerId: string) => {
    setFocusWorkbench((current) => ({ panes: setPaneWorker(current.panes, paneId, workerId), focusedPaneId: paneId }));
    activateNpc(workerId);
  }, [activateNpc]);

  const focusPane = useCallback((paneId: string) => {
    setFocusWorkbench((current) => (current.focusedPaneId === paneId ? current : { ...current, focusedPaneId: paneId }));
    const worker = focusPanes.find((pane) => pane.id === paneId)?.workerId;
    if (worker) activateNpc(worker);
  }, [activateNpc, focusPanes]);

  const addFocusPane = useCallback(() => {
    setFocusWorkbench((current) => ({ ...current, panes: addPane(current.panes, MAX_FOCUS_PANES) }));
  }, []);

  const removeFocusPane = useCallback((paneId: string) => {
    setFocusWorkbench((current) => {
      const panes = removePane(current.panes, paneId);
      const focusedPaneId = panes.some((pane) => pane.id === current.focusedPaneId) ? current.focusedPaneId : panes[0].id;
      return { panes, focusedPaneId };
    });
  }, []);

  const setFocusPaneLayout = useCallback((count: 1 | 2 | 3 | 4) => {
    setFocusWorkbench((current) => {
      const seeds = current.panes.map((pane) => pane.workerId);
      const panes = createFocusPanes(count, seeds);
      const previousIndex = Math.max(0, current.panes.findIndex((pane) => pane.id === current.focusedPaneId));
      return { panes, focusedPaneId: panes[Math.min(previousIndex, panes.length - 1)].id };
    });
  }, []);

  const cycleFocusPane = useCallback((direction: 1 | -1): boolean => {
    if (focusPanes.length < 2) return false;
    const index = focusPanes.findIndex((pane) => pane.id === focusedPaneId);
    const next = focusPanes[(index + direction + focusPanes.length) % focusPanes.length];
    focusPane(next.id);
    return true;
  }, [focusPane, focusPanes, focusedPaneId]);

  const resolveTaskApproval = useCallback((approvalId: string, decision: ApprovalDecision) => {
    const owner = workerList.find((worker) => worker.turns.some((turn) => turn.items.some((item) => item.kind === "approval" && item.request.id === approvalId)));
    return owner ? resolveApproval(owner.id, approvalId, decision) : Promise.resolve(t("找不到需要核准的 NPC"));
  }, [resolveApproval, workerList]);

  const selectFocusStudio = useCallback((workspacePath: string): boolean => {
    const studio = focusStudios.find((candidate) => candidate.workspacePath === workspacePath);
    const workerId = studio && studioWorkerId(studio, preferences.focusStudioLastWorkerIds[workspacePath]);
    if (!workerId) return false;
    assignWorkerToPane(focusedPaneId, workerId);
    return true;
  }, [assignWorkerToPane, focusStudios, focusedPaneId, preferences.focusStudioLastWorkerIds]);

  const notifySnapshots = useRef(new Map<string, WorkerSnapshot>());
  useEffect(() => {
    const prev = notifySnapshots.current;
    const events = diffNotifications(prev, workerList);
    notifySnapshots.current = new Map(workerList.map((worker) => [worker.id, snapshotWorker(worker)]));
    if (!preferences.notificationsEnabled || !events.length) return;
    if (typeof Notification === "undefined" || Notification.permission !== "granted" || !document.hidden) return;
    for (const event of events) {
      try {
        const shown = new Notification(event.title, { body: event.body, tag: event.tag });
        shown.onclick = () => window.focus();
      } catch {
        // Some browsers require a ServiceWorker for constructor Notifications.
      }
    }
  }, [workerList, preferences.notificationsEnabled]);

  const toggleNotifications = useCallback(() => {
    if (preferences.notificationsEnabled) {
      updatePreferences({ notificationsEnabled: false });
      return;
    }
    if (typeof Notification === "undefined") {
      notify(t("這個瀏覽器不支援桌面通知"), "error");
      return;
    }
    void Notification.requestPermission().then((permission) => {
      if (permission === "granted") {
        updatePreferences({ notificationsEnabled: true });
        notify(t("桌面通知已開啟：任務完成或等待核准時通知（分頁在背景才會跳）"));
      } else {
        notify(t("瀏覽器未授權通知，請在網址列旁的權限設定允許"), "error");
      }
    });
  }, [preferences.notificationsEnabled, updatePreferences, notify]);

  useEffect(() => {
    if (workspaceSetupRequired) {
      setWorkspaceMode("create");
      setNewWorkerProvider(activeProvider);
      setWorkspaceOpen(true);
    }
  }, [workspaceSetupRequired, activeProvider]);

  const openWorkspaceForCreate = useCallback((provider: ProviderId) => {
    setNewWorkerProvider(provider);
    setNewWorkerAccountId(null);
    setWorkspaceMode("create");
    setWorkspaceOpen(true);
  }, []);

  const openWorkspaceForMove = useCallback(() => {
    setWorkspaceMode("move");
    setWorkspaceOpen(true);
  }, []);

  const openDepartmentMission = useCallback((departmentKey: string, options?: { missionId?: string; focusSection?: "team" | "history" }) => {
    const departmentRecord = departments[departmentKey];
    const department = workerList.filter((worker) => departmentRecord
      ? worker.departmentId === departmentRecord.id
      : worker.workspacePath === departmentKey);
    if (department.length === 0) return;
    const existing = Object.values(missions).find((mission) =>
      (departmentRecord ? mission.departmentId === departmentRecord.id : mission.workspacePath === departmentKey)
      && ["planning", "executing", "reviewing", "needs_attention"].includes(mission.status)
    );
    const leadership = /(主管|經理|負責人|協調|lead|manager|architect|架構)/i;
    const coordinator = (existing ? workers[existing.bossWorkerId] : undefined)
      ?? (departmentRecord ? workers[departmentRecord.leadWorkerId] : undefined)
      ?? department.find((worker) => leadership.test(`${worker.persona?.role ?? ""} ${worker.name}`))
      ?? department.find((worker) => !worker.busy)
      ?? department[0];
    setSelectedDepartmentId(departmentRecord?.id ?? coordinator.departmentId ?? null);
    setBossMissionDetailId(options?.missionId ?? null);
    setDepartmentFocusSection(options?.focusSection ?? null);
    setBossAssignmentOpen(false);
    updatePreferences({ taskLogOpen: true });
  }, [departments, missions, updatePreferences, workerList, workers]);

  const selectDepartment = useCallback((departmentId: string) => {
    const department = departments[departmentId];
    if (!department) return;
    setSelectedDepartmentId(departmentId);
    setBossMissionDetailId(null);
    setDepartmentFocusSection(null);
    setBossAssignmentOpen(false);
    setTaskSearchOpen(false);
    updatePreferences({ taskLogOpen: true });
  }, [departments, updatePreferences]);

  const approvalWorker = useMemo(() => workerList.find((worker) => worker.turns.some((turn) =>
    turn.items.some((item) => item.kind === "approval" && item.status === "pending")
  )), [workerList]);

  const enterTaskFocusMode = useCallback(() => {
    focusReturnRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setFocusSeenTurns(Object.fromEntries(workerList.map((worker) => [worker.id, latestReadableTurnKey(worker)])));
    const panes = createFocusPanes(preferences.focusPaneLayout, [activeId]);
    setFocusWorkbench({ panes, focusedPaneId: panes[0].id });
    updatePreferences({ taskLogOpen: true, taskFocusMode: true });
  }, [activeId, preferences.focusPaneLayout, updatePreferences, workerList]);

  const exitTaskFocusMode = useCallback(() => {
    setFocusUsageOpen(false);
    updatePreferences({ taskFocusMode: false });
  }, [updatePreferences]);

  const shortcuts = useMemo(() => ({
    onCommandPalette: () => setCommandPaletteOpen(true),
    onShortcutsHelp: () => setShortcutsHelpOpen((open) => !open),
    onStudioShortcut: (index: number) => taskFocusMode ? selectFocusStudio(focusStudios[index]?.workspacePath ?? "") : false,
    onPaneCycle: (direction: 1 | -1) => taskFocusMode && cycleFocusPane(direction),
    onToggleTaskLog: () => taskFocusMode
      ? exitTaskFocusMode()
      : updatePreferences({ taskLogOpen: !preferences.taskLogOpen }),
    onApproval: () => {
      if (!approvalWorker) return;
      if (taskFocusMode) {
        assignWorkerToPane(focusedPaneId, approvalWorker.id);
        return;
      }
      setActiveId(approvalWorker.id);
      setSelectedDepartmentId(null);
      setBossMissionDetailId(null);
      updatePreferences({ taskLogOpen: true });
    },
    onEscape: () => {
      // The roundtable overflow and its two child surfaces live beside the
      // composer rather than inside the standard modal family. Dismiss them
      // before consulting the Focus Reader layer so one Escape cannot close a
      // menu/history panel *and* leave Focus Mode in the same keypress.
      if (roundtableMenuOpen) {
        setRoundtableMenuOpen(false);
        return;
      }
      if (stancesOpen) {
        setStancesOpen(false);
        return;
      }
      if (warroomHistory) {
        setWarroomHistory(null);
        setWarroomHistoryContent(null);
        return;
      }
      // These overlays already have their own Escape-to-close handling and can be
      // reached from inside focus mode; without this guard, closing one of them
      // would also silently exit focus mode via the layer check below.
      const overlayModalOpen = workspaceOpen || departmentCreatorOpen || commandCenterOpen || mcpModalOpen || codexCommandsModalOpen || accountsModalOpen || backupModalOpen
        || shortcutsHelpOpen || Boolean(avatarWorkerId) || Boolean(handoffTarget) || Boolean(personaWorkerId) || Boolean(pendingAutoApproveMode);
      if (overlayModalOpen) return;
      const layer = topDismissibleLayer(commandPaletteOpen, taskSearchOpen, taskFocusMode);
      if (layer === "command_palette") {
        setCommandPaletteOpen(false);
        return;
      }
      if (layer === "task_search") {
        setTaskSearchOpen(false);
        return;
      }
      if (layer === "focus_mode") {
        exitTaskFocusMode();
        return;
      }
      setCommandPaletteOpen(false);
      setTaskSearchOpen(false);
    },
  }), [approvalWorker, assignWorkerToPane, avatarWorkerId, backupModalOpen, accountsModalOpen, codexCommandsModalOpen, commandCenterOpen, commandPaletteOpen, cycleFocusPane, departmentCreatorOpen, exitTaskFocusMode, focusStudios, focusedPaneId, handoffTarget, mcpModalOpen, pendingAutoApproveMode, personaWorkerId, preferences.taskLogOpen, roundtableMenuOpen, selectFocusStudio, setActiveId, shortcutsHelpOpen, stancesOpen, taskFocusMode, taskSearchOpen, updatePreferences, warroomHistory, workspaceOpen]);
  useKeyboardShortcuts(shortcuts);

  useEffect(() => {
    setTaskSearch("");
    setTaskSearchOpen(false);
    setFocusUsageOpen(false);
    setCommandPaletteOpen(false);
  }, [activeId, activeProvider, activeWorkspace]);

  useEffect(() => {
    if (selectedDepartmentId && !departments[selectedDepartmentId]) {
      setSelectedDepartmentId(null);
      setBossMissionDetailId(null);
    }
  }, [departments, selectedDepartmentId]);

  useEffect(() => {
    if (!taskFocusMode) return;
    const previousFocus = focusReturnRef.current;
    focusExitRef.current?.focus();
    return () => {
      if (previousFocus?.isConnected) previousFocus.focus();
      focusReturnRef.current = null;
    };
  }, [taskFocusMode]);

  // A worker counts as "seen" once it's showing in any visible pane, not just
  // the focused one — split view lets you watch a pane you're not typing into.
  useEffect(() => {
    if (!taskFocusMode) return;
    const assignedIds = focusPanes.map((pane) => pane.workerId).filter((id): id is string => Boolean(id));
    if (assignedIds.length === 0) return;
    setFocusSeenTurns((current) => {
      let changed = false;
      const next = { ...current };
      for (const id of assignedIds) {
        const worker = workers[id];
        if (!worker) continue;
        const latestKey = latestReadableTurnKey(worker);
        if (next[id] !== latestKey) { next[id] = latestKey; changed = true; }
      }
      return changed ? next : current;
    });
  }, [focusPanes, taskFocusMode, workers]);

  // Any pane add/remove/layout-switch persists as the next "enter focus mode" default.
  useEffect(() => {
    if (!taskFocusMode) return;
    const count = focusPanes.length as 1 | 2 | 3 | 4;
    if (preferences.focusPaneLayout !== count) updatePreferences({ focusPaneLayout: count });
  }, [focusPanes.length, preferences.focusPaneLayout, taskFocusMode, updatePreferences]);

  // activeId can change via paths that don't go through assignWorkerToPane
  // (e.g. the approval shortcut outside focus mode); keep the focused pane in
  // sync so its QuestLog/composer never point at different workers.
  useEffect(() => {
    if (!taskFocusMode || !activeId) return;
    setFocusWorkbench((current) => {
      const focused = current.panes.find((pane) => pane.id === current.focusedPaneId);
      if (!focused || focused.workerId === activeId) return current;
      return { ...current, panes: setPaneWorker(current.panes, current.focusedPaneId, activeId) };
    });
  }, [activeId, taskFocusMode]);

  useEffect(() => {
    if (taskFocusMode && !preferences.taskLogOpen) updatePreferences({ taskLogOpen: true });
  }, [preferences.taskLogOpen, taskFocusMode, updatePreferences]);

  useEffect(() => () => resizeCleanupRef.current?.(), []);

  useEffect(() => {
    let previousWidth = window.innerWidth;
    const preserveOffice = () => {
      const currentWidth = window.innerWidth;
      if (shouldAutoCollapseTaskLog(previousWidth, currentWidth, taskFocusMode)) {
        updatePreferences({ taskLogOpen: false });
      }
      previousWidth = currentWidth;
    };
    window.addEventListener("resize", preserveOffice);
    return () => window.removeEventListener("resize", preserveOffice);
  }, [taskFocusMode, updatePreferences]);

  function beginPanelResize(event: React.PointerEvent<HTMLButtonElement>) {
    event.preventDefault();
    // On phones the log is a full-width bottom sheet, so a width drag does nothing
    // visible; there the same handle sits along the top edge and drags the sheet's
    // height instead (up = taller). Desktop keeps the left-edge width drag.
    const phoneSheet = window.innerWidth <= 600;
    const startX = event.clientX;
    const startY = event.clientY;
    const startWidth = preferences.taskLogWidth;
    const startHeight = preferences.taskLogHeight;
    let lastY = startY;
    const move = (moveEvent: PointerEvent) => {
      lastY = moveEvent.clientY;
      updatePreferences(phoneSheet
        ? { taskLogHeight: clampTaskLogHeight(startHeight + (startY - moveEvent.clientY) / window.innerHeight * 100) }
        : { taskLogWidth: clampTaskLogWidth(startWidth + startX - moveEvent.clientX, window.innerWidth) });
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", cleanup);
      window.removeEventListener("pointercancel", cleanup);
      resizeCleanupRef.current = null;
      // Phone bottom sheet: a firm downward flick on the top grabber dismisses it,
      // restoring the height so it reopens at the same size (not the shrunk one).
      if (phoneSheet && lastY - startY > 90) updatePreferences({ taskLogOpen: false, taskLogHeight: startHeight });
    };
    resizeCleanupRef.current?.();
    resizeCleanupRef.current = cleanup;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", cleanup);
    window.addEventListener("pointercancel", cleanup);
  }

  function trapFocusInReader(event: React.KeyboardEvent<HTMLElement>) {
    if (!taskFocusMode) return;
    if (event.key === "Escape" && focusUsageOpen) {
      event.preventDefault();
      event.stopPropagation();
      setFocusUsageOpen(false);
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [...(focusLayerRef.current?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
    ) ?? [])].filter((element) => element.getClientRects().length > 0);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  async function changeProvider(provider: ProviderId) {
    if (provider === activeProvider || providerChanging) return;
    if (!active) return;
    if (active.turns.length === 0) {
      setProviderChanging(true);
      const prepared = await prepareHandoff(active.id, provider);
      if (prepared.error || !prepared.data) {
        notify(prepared.error || t("無法檢查目標 LLM"), "error");
        setProviderChanging(false);
        return;
      }
      // Trust the server's persisted history check over the local projection.
      // If the UI was stale, fall back to the normal warning dialog.
      if (prepared.data.hasHistory) {
        setProviderChanging(false);
        setHandoffTarget(provider);
        return;
      }
      const error = await startHandoff(active.id, prepared.data.handoffToken);
      setProviderChanging(false);
      if (error) notify(error, "error");
      else notify(t("正在切換至 {provider}", { provider: provider === "claude" ? "Claude Code" : "Codex" }), "info");
      return;
    }
    setHandoffTarget(provider);
  }

  async function handleRename(id: string, name: string) {
    const error = await renameWorker(id, name);
    if (!error) notify(t("人員名稱已更新"));
    return error;
  }

  function handleRemoveWorker(id: string) {
    const name = workers[id]?.name;
    if (!window.confirm(name ? t("確定永久移除「{name}」嗎？工位與完整對話紀錄都會一併拆除，此動作無法復原。", { name }) : t("確定永久移除這位 NPC 嗎？此動作無法復原。"))) return;
    void closeWorker(id).then((error) => error ? notify(error, "error") : notify(t("人員與工位拆除中"), "info"));
  }

  function handleSetWorkerAccount(workerId: string, accountId: string | null) {
    // TopBar already hard-disables this control once the NPC has any conversation
    // history (switching mid-session can't resume the old thread under the new
    // account anyway) — this is just the plain follow-through for a fresh NPC.
    void setWorkerAccount(workerId, accountId).then((error) => { if (error) notify(error, "error"); });
  }

  function handleModelChange(model: string) {
    if (!activeId || model === (active?.model ?? "")) return;
    setPendingModelSwitch({ workerId: activeId, model });
    updatePreferences({ taskLogOpen: true });
  }

  function commitModelSwitch(fresh: boolean) {
    if (!pendingModelSwitch || modelSwitchSubmitting) return;
    const { workerId, model } = pendingModelSwitch;
    setModelSwitchSubmitting(true);
    void (fresh ? setModelFresh(workerId, model) : setModel(workerId, model)).then((error) => {
      setModelSwitchSubmitting(false);
      if (error) {
        notify(error, "error");
        return;
      }
      setPendingModelSwitch(null);
      notify(fresh ? t("已切換模型並開啟全新工作階段") : t("模型設定已更新"));
    });
  }

  function applyAutoApproveMode(workerId: string, mode: AutoApproveMode) {
    void setAutoApproveMode(workerId, mode).then((error) => {
      if (error) { notify(error, "error"); return; }
      if (mode === "off") notify(t("自動核准已關閉"));
      else if (mode === "safe") notify(t("安全自動核准已開啟；只有唯讀與驗證安全的指令會跳過詢問"));
      else if (mode === "full") notify(t("完全自動核准已開啟；除了已辨識的高風險 Bash 指令，檔案變更、MCP 動作與其他指令都會直接放行"));
      else notify(t("⚡ 無限制模式已開啟：完全不設限、永不詢問（連 rm -rf、sudo 都放行），風險自負！"), "info");
    });
  }

  function handleAutoApproveChange(mode: AutoApproveMode) {
    if (!active) return;
    if (requiresAutoApproveConfirmation(active.autoApproveMode, mode)) {
      setPendingAutoApproveMode({ workerId: active.id, workerName: active.name, workspacePath: active.workspacePath, mode });
      return;
    }
    applyAutoApproveMode(active.id, mode);
  }

  function confirmAutoApproveMode() {
    if (!pendingAutoApproveMode) return;
    const { workerId, mode } = pendingAutoApproveMode;
    setPendingAutoApproveMode(null);
    applyAutoApproveMode(workerId, mode);
  }

  async function requestServerRestart() {
    if (restartPending) return;
    if (!window.confirm(t("確定要重啟伺服器？會等所有 NPC 都空檔後才執行，不會打斷任何回合。"))) return;
    try {
      await apiRequest<{ ok: boolean }>("/api/restart-server", { method: "POST" });
      setRestartPending(true);
      notify(t("已排程重啟：等所有 NPC 空檔後自動重啟背景服務"), "info");
    } catch (error) {
      notify(error instanceof Error ? error.message : t("重啟請求失敗"), "error");
    }
  }

  async function requestServerShutdown() {
    if (!window.confirm(t("確定要關閉背景服務？所有進行中的 NPC 工作都會中斷，之後可再雙擊 Pixel Crew 重新啟動。"))) return;
    try {
      await apiRequest<{ ok: boolean }>("/api/shutdown-server", { method: "POST" });
      notify(t("背景服務正在關閉，這個頁面即將失去連線。"), "info");
    } catch (error) {
      notify(error instanceof Error ? error.message : t("關閉服務請求失敗"), "error");
    }
  }

  return (
    <div className={`game-root ${theme === "modern" ? "game-root--modern" : ""} ${taskFocusMode ? "game-root--focus" : ""} ${taskFocusMode && !bossAssignmentOpen && !selectedDepartment && focusPanes.length > 1 ? "game-root--focus-split" : ""} ${preferences.taskLogOpen ? "game-root--task-log-open" : ""} ${preferences.crewRailCollapsed ? "game-root--crew-collapsed" : ""}`} style={{
      "--log-panel-width": `${preferences.taskLogWidth}px`,
      "--log-panel-height": `${preferences.taskLogHeight}vh`,
    } as CSSProperties}>
      {theme === "modern" ? (
        // 現代主題：3D 娃娃屋只當背景層，頂欄/日誌/對話/圓桌/Modal 全部沿用下方共用元件＝功能與像素風一致。
        // 場景僅提供「點角色 = 選取」；改名/個性/派工等 NPC 操作走右側隊員列（WorkerTabs）與頂欄，跟像素風同入口。
        <Office3D
          workers={workerList}
          departments={departmentList}
          active={active ?? null}
          onSelect={activateNpc}
        />
      ) : (
      <GameCanvas
        workers={workerList}
        activeId={activeId}
        completedTurns={stats.completedTurns}
        collaborations={collaborationList}
        missions={missionList}
        departments={departmentList}
        roundtableIds={roundtableIdSet}
        swapThresholdTokens={system?.brainSwapThresholdTokens}
        onMeetingTableClick={() => {
          setDiscussionMode("warroom");
          setComposerFocusRequest((request) => request + 1);
          notify(t("🏛️ 作戰室模式已開啟——輸入問題送出即召開多 Agent 辯論"), "info");
        }}
        onEmptyTap={() => { if (preferences.taskLogOpen) updatePreferences({ taskLogOpen: false }); }}
        onSelect={activateNpc}
        onOpenLog={activateNpc}
        onAvatarError={(id, message) => { setActiveId(id); notify(message, "error"); }}
        onRename={handleRename}
        onAvatarWorkshop={setAvatarWorkerId}
        onPersonaEditor={setPersonaWorkerId}
        onDepartmentMission={openDepartmentMission}
        onRenameDepartment={renameDepartment}
        onRoomSwitch={(id) => { setActiveId(id); openWorkspaceForMove(); }}
        onRemove={handleRemoveWorker}
        onResolveApproval={resolveApproval}
      />
      )}

      {/* 主題切換統一走頂欄那顆 🎨 像素｜現代（TopBar），這裡不再放浮動鈕＝避免左下角與縮放條重疊、功能重複。 */}
      <TopBar
        active={active}
        activeWorkspace={activeWorkspace}
        platform={system?.platform}
        capabilities={activeCapabilities}
        auth={activeAuth}
        wsReady={wsReady}
        modelOptions={modelOptions}
        workerCount={workerList.length}
        providerChanging={providerChanging}
        accounts={Object.values(accounts)}
        onSetWorkerAccount={handleSetWorkerAccount}
        onRoom={() => active ? openWorkspaceForMove() : openWorkspaceForCreate(activeProvider)}
        onBossAssignment={openBossDesk}
        onOpenMcp={() => setMcpModalOpen(true)}
        onOpenAccounts={() => setAccountsModalOpen(true)}
        onOpenBackup={() => setBackupModalOpen(true)}
        onOpenOps={() => setOpsModalOpen(true)}
        onOpenKanban={() => setKanbanModalOpen(true)}
        onOpenDayReport={() => setDayReportOpen(true)}
        onOpenOutbox={() => setOutboxOpen(true)}
        onOpenTour={openTour}
        onOpenRemote={() => setRemoteModalOpen(true)}
        onRestart={() => void requestServerRestart()}
        onShutdown={() => void requestServerShutdown()}
        restartPending={restartPending}
        onProvider={(provider) => void changeProvider(provider)}
        onModel={handleModelChange}
        onAutoApprove={handleAutoApproveChange}
        onRefreshAuth={() => void refreshAuth(activeProvider)}
        onResetUi={() => { resetPreferences(); notify(t("介面配置已重設"), "info"); }}
        notificationsEnabled={preferences.notificationsEnabled}
        onNotificationsToggle={toggleNotifications}
        updateInfo={updateInfo}
      >
        {!taskFocusMode && <EnergyHud usage={providerUsage} onRefresh={refreshUsage} totalCostUsd={stats.totalCostUsd} />}
      </TopBar>

      {!wsReady && <div className="system-banner system-banner--error" role="alert"><i />{t("本機服務重新連線中，現有畫面會保留。")}</div>}
      {wsReady && activeProvider === "codex" && system?.codexWindowsBestEffort && <div className="system-banner" role="status"><i />{t("Windows 10 可使用 Codex，但原生沙箱屬上游 best-effort；Windows 11 會更穩定。")}</div>}

      <button
        className={`panel-toggle ${preferences.taskLogOpen ? "panel-toggle--open" : ""}`}
        // Capture the pointer so a tap OR a swipe off the button both toggle: on a
        // phone the log is a bottom sheet, and users instinctively press this arrow
        // and drag to dismiss. Without capture the drag was eaten by the canvas
        // (pan) and the release never counted as a click, so the log wouldn't close.
        onPointerDown={(event) => { try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* noop */ } }}
        onPointerUp={() => updatePreferences({ taskLogOpen: !preferences.taskLogOpen })}
        onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); updatePreferences({ taskLogOpen: !preferences.taskLogOpen }); } }}
        title={t(preferences.taskLogOpen ? "收合任務日誌（⌘/Ctrl J）" : "展開任務日誌（⌘/Ctrl J）")}
        aria-label={t(preferences.taskLogOpen ? "收合任務日誌" : "展開任務日誌")}
      >
        {preferences.taskLogOpen ? "▶" : "◀"}
      </button>

      <div
        ref={focusLayerRef}
        className="task-focus-layer"
        aria-label={taskFocusMode ? t("專心閱讀與輸入") : undefined}
        aria-modal={taskFocusMode || undefined}
        role={taskFocusMode ? "dialog" : undefined}
        onKeyDown={trapFocusInReader}
      >
      <aside
        className={`holo-panel ${isTaskLogVisible(preferences.taskLogOpen, taskFocusMode) ? "" : "holo-panel--closed"} ${taskFocusMode ? "holo-panel--focus" : ""}`}
        aria-label={taskFocusMode ? t("專心閱讀任務報告") : t("任務日誌")}
      >
        {!taskFocusMode && <button type="button" className="holo-panel__resize" aria-label={t("調整任務日誌大小")} title={t("拖曳調整；雙擊恢復預設")} onPointerDown={beginPanelResize} onDoubleClick={() => updatePreferences(window.innerWidth <= 600 ? { taskLogHeight: 62 } : { taskLogWidth: 600 })} onKeyDown={(event) => {
          if (window.innerWidth <= 600) {
            if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
            event.preventDefault();
            updatePreferences({ taskLogHeight: clampTaskLogHeight(preferences.taskLogHeight + (event.key === "ArrowUp" ? 5 : -5)) });
            return;
          }
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          event.preventDefault();
          updatePreferences({ taskLogWidth: preferences.taskLogWidth + (event.key === "ArrowLeft" ? 24 : -24) });
        }} />}
        <div className="holo-panel__title">
          <div className="holo-panel__heading"><span className="holo-panel__eyebrow">{bossAssignmentOpen ? taskFocusMode ? "FOCUS BOSS DESK" : "BOSS DESK" : taskFocusMode ? selectedDepartment ? "FOCUS DEPARTMENT" : "FOCUS READER" : selectedDepartment ? "DEPARTMENT WORK" : "WORKSTREAM"}</span><strong>{bossAssignmentOpen ? t("老闆交辦") : taskFocusMode ? selectedDepartment ? t("專注部門") : t("專心閱讀") : selectedDepartment ? selectedDepartment.name : t("任務日誌")}</strong></div>
          {taskFocusMode ? <div className="focus-context-switch">
            <div className="focus-context-switch__kind" aria-label={t("專注模式工作對象")}>
              <button type="button" className={!selectedDepartment && !bossAssignmentOpen ? "active" : ""} onClick={() => activeId && activateNpc(activeId)}>NPC</button>
              <button type="button" className={selectedDepartment ? "active" : ""} disabled={Object.keys(departments).length === 0} onClick={() => selectedDepartmentId ? selectDepartment(selectedDepartmentId) : Object.keys(departments)[0] && selectDepartment(Object.keys(departments)[0])}>{t("部門")}</button>
              <button type="button" className={bossAssignmentOpen ? "active" : ""} onClick={() => { setBossAssignmentOpen(true); setSelectedDepartmentId(null); setBossMissionDetailId(null); }}>{t("老闆")}</button>
            </div>
            {!bossAssignmentOpen && (!selectedDepartment ? (focusPanes.length <= 1 && <div className="focus-worker-switch">
              <select aria-label={t("切換專心模式的 NPC 工作介面")} value={activeId ?? ""} onChange={(event) => assignWorkerToPane(focusedPaneId, event.target.value)}>
                {!activeId && <option value="" disabled>{t("選擇 NPC")}</option>}
                {focusStudioDepartmentGroups.map(({ department, workers: departmentWorkers }) => <optgroup key={department.id} label={department.name}>{departmentWorkers.map((worker) => {
                  const unread = worker.id !== activeId && workerHasUnread(worker, focusSeenTurns[worker.id] ?? undefined);
                  return <option key={worker.id} value={worker.id}>{focusWorkerLabel(worker, unread)}</option>;
                })}</optgroup>)}
                {focusStudioStandaloneWorkers.map((worker) => <option key={worker.id} value={worker.id}>{focusWorkerLabel(worker)}</option>)}
              </select>
            </div>) : <div className="focus-worker-switch focus-department-switch"><select aria-label={t("切換專心模式的部門工作介面")} value={selectedDepartment.id} onChange={(event) => selectDepartment(event.target.value)}>{Object.values(departments).map((department) => {
              const mission = Object.values(missions).find((candidate) => candidate.departmentId === department.id && ["planning", "executing", "reviewing", "needs_attention"].includes(candidate.status));
              return <option key={department.id} value={department.id}>{department.name}{mission ? ` · ${mission.status === "needs_attention" ? t("需處理") : t("進行中")}` : ` · ${t("待命")}`}</option>;
            })}</select></div>)}
          </div> : bossAssignmentOpen ? <span className="holo-panel__worker holo-panel__department"><i />{t("依部門職責與 NPC 職務自動路由")}</span> : selectedDepartment ? <span className="holo-panel__worker holo-panel__department"><i />{t("{count} 位 NPC", { count: String(selectedDepartment.memberWorkerIds.length) })} · {selectedDepartment.purpose}</span> : active && <span className="holo-panel__worker"><i />{active.name}</span>}
          {taskFocusMode && <FocusEnergy usage={providerUsage} onRefresh={refreshUsage} totalCostUsd={stats.totalCostUsd} activeProvider={activeProvider} activeSubject={active ? { name: active.name, provider: active.provider, model: focusModelLabel(active) } : undefined} open={focusUsageOpen} onOpenChange={setFocusUsageOpen} anchored={focusPanes.length > 1} />}
          <div className="task-log-toolbar">
            {!taskFocusMode && !selectedDepartment && !bossAssignmentOpen && <div className="task-log-toolbar__view" aria-label={t("日誌模式")}>
              <button type="button" className={preferences.taskLogView === "summary" ? "active" : ""} onClick={() => updatePreferences({ taskLogView: "summary" })}>{t("摘要")}</button>
              <button type="button" className={preferences.taskLogView === "activity" ? "active" : ""} onClick={() => updatePreferences({ taskLogView: "activity" })}>{t("活動")}</button>
            </div>}
            {!selectedDepartment && !bossAssignmentOpen && <button type="button" className={`task-log-toolbar__search ${taskSearchOpen ? "active" : ""}`} onClick={() => setTaskSearchOpen((open) => !open)} aria-label={t("搜尋任務日誌")} title={t("搜尋")}>
              <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="5.5" /><path d="m15 15 4.5 4.5" /></svg>
            </button>}
            {!taskFocusMode && <button type="button" className="task-log-toolbar__focus" onClick={enterTaskFocusMode} aria-label={t("進入專心閱讀模式")} title={t("專心閱讀")}><span aria-hidden="true">▣</span> {t("專心")}</button>}
            {!taskFocusMode && <select aria-label={t("日誌寬度")} value={preferences.taskLogWidth < 510 ? "420" : preferences.taskLogWidth > 720 ? "820" : "600"} onChange={(event) => updatePreferences({ taskLogWidth: Number(event.target.value) })}>
              <option value="420">{t("緊湊")}</option><option value="600">{t("閱讀")}</option><option value="820">{t("寬版")}</option>
            </select>}
            {taskFocusMode && !selectedDepartment && !bossAssignmentOpen && <div className="focus-pane-toggle" role="group" aria-label={t("分割視窗數量")}>
              {([1, 2, 3, 4] as const).map((count) => (
                <button key={count} type="button" className={focusPanes.length === count ? "active" : ""} title={t("分割成 {count} 個視窗", { count: String(count) })} onClick={() => setFocusPaneLayout(count)}>{count}</button>
              ))}
            </div>}
            {taskFocusMode && <FocusControls
              active={active}
              workerCount={workerList.length}
              modelOptions={modelOptions}
              authReady={activeAuth.status === "authenticated"}
              providerChanging={providerChanging}
              notificationsEnabled={preferences.notificationsEnabled}
              onModel={handleModelChange}
              onAutoApprove={handleAutoApproveChange}
              onProvider={(provider) => void changeProvider(provider)}
              onRename={handleRename}
              onPersona={() => active && setPersonaWorkerId(active.id)}
              onAvatar={() => active && setAvatarWorkerId(active.id)}
              onRoom={openWorkspaceForMove}
              onRemove={handleRemoveWorker}
              onCreateNpc={() => openWorkspaceForCreate(activeProvider)}
              onCreateDepartment={() => { setDepartmentCreatorOpen(true); }}
              onOpenMcp={() => setMcpModalOpen(true)}
              onOpenCodexCommands={() => setCodexCommandsModalOpen(true)}
              onOpenAccounts={() => setAccountsModalOpen(true)}
              onOpenBackup={() => setBackupModalOpen(true)}
              onNotificationsToggle={toggleNotifications}
              onOpenCommandCenter={() => { setCommandPaletteOpen(false); setCommandCenterOpen(true); }}
            />}
            {taskFocusMode && <button ref={focusExitRef} type="button" className="task-log-toolbar__exit" onClick={exitTaskFocusMode} aria-label={t("退出專心閱讀模式")}>{t("退出")} <kbd>Esc</kbd></button>}
          </div>
        </div>
        {bossAssignmentOpen && <BossTaskDesk
          workspacePath={activeWorkspace}
          tasks={Object.values(bossTasks)}
          decisionModels={decisionModelOptions}
          onCreate={createBossTask}
          onMessage={messageBossTask}
          onUpdate={updateBossTask}
          onDelete={deleteBossTask}
          onOpenMission={(missionId) => {
            const mission = missions[missionId];
            if (!mission?.departmentId) return;
            setBossAssignmentOpen(false);
            setBossMissionDetailId(missionId);
            setSelectedDepartmentId(mission.departmentId);
          }}
          onClose={() => setBossAssignmentOpen(false)}
          composerHost={composerHost}
          focusMode={taskFocusMode}
        />}
        {!bossAssignmentOpen && !selectedDepartment && taskSearchOpen && <div className="task-log-search"><span className="task-log-search__icon"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="5.5" /><path d="m15 15 4.5 4.5" /></svg></span><input value={taskSearch} autoFocus placeholder={taskSearchScope === "current" ? t("搜尋目前 NPC 的任務") : t("搜尋全部 NPC 的任務")} onChange={(event) => setTaskSearch(event.target.value)} /><div className="task-log-search__scope" aria-label={t("搜尋範圍")}><button type="button" className={taskSearchScope === "current" ? "active" : ""} onClick={() => setTaskSearchScope("current")}>{t("目前")}</button><button type="button" className={taskSearchScope === "all" ? "active" : ""} onClick={() => setTaskSearchScope("all")}>{t("全部")}</button></div><button type="button" onClick={() => { setTaskSearch(""); setTaskSearchOpen(false); }}>×</button></div>}
        {!bossAssignmentOpen && !selectedDepartment && active && pendingModelSwitch?.workerId === active.id && <ModelSwitchCard
          workerName={active.name}
          currentModelLabel={modelOptions.find((option) => option.id === (active.model ?? ""))?.label ?? active.model ?? t("預設模型")}
          targetModelLabel={modelOptions.find((option) => option.id === pendingModelSwitch.model)?.label ?? (pendingModelSwitch.model || t("預設模型"))}
          focusMode={taskFocusMode}
          submitting={modelSwitchSubmitting}
          onContinue={() => commitModelSwitch(false)}
          onFresh={() => commitModelSwitch(true)}
          onCancel={() => setPendingModelSwitch(null)}
        />}
        {!bossAssignmentOpen && !selectedDepartment && (taskFocusMode && focusPanes.length > 1 ? <FocusPaneGrid
          panes={focusPanes}
          focusedPaneId={focusedPaneId}
          workers={workers}
          departmentGroups={focusStudioDepartmentGroups}
          standaloneWorkers={focusStudioStandaloneWorkers}
          workerLabel={(worker, unread) => focusWorkerLabel(worker, unread)}
          isUnread={(worker) => workerHasUnread(worker, focusSeenTurns[worker.id] ?? undefined)}
          view={preferences.taskLogView}
          searchQuery={taskSearch}
          maxPanes={MAX_FOCUS_PANES}
          studioRail={<FocusStudios studios={focusStudios} activeWorkspace={activeWorkspace} collapsed={preferences.focusStudiosCollapsed} onCollapsedChange={(collapsed) => updatePreferences({ focusStudiosCollapsed: collapsed })} onSelect={selectFocusStudio} onCreateNpc={() => openWorkspaceForCreate(activeProvider)} />}
          onFocusPane={focusPane}
          onAssignWorker={assignWorkerToPane}
          onAddPane={addFocusPane}
          onRemovePane={removeFocusPane}
          onApprove={resolveTaskApproval}
        /> : <QuestLog key={`${activeSessionKey}:${taskSearchScope}`} readerKey={activeSessionKey} turns={taskLogTurns} view={preferences.taskLogView} searchQuery={taskSearch} focusMode={taskFocusMode} studioRail={taskFocusMode ? <FocusStudios studios={focusStudios} activeWorkspace={activeWorkspace} collapsed={preferences.focusStudiosCollapsed} onCollapsedChange={(collapsed) => updatePreferences({ focusStudiosCollapsed: collapsed })} onSelect={selectFocusStudio} onCreateNpc={() => openWorkspaceForCreate(activeProvider)} /> : undefined} studioRailCollapsed={preferences.focusStudiosCollapsed} onApprove={resolveTaskApproval} />)}
        {!bossAssignmentOpen && selectedDepartment && selectedDepartmentLead && <DepartmentMissionDialog
          embedded
          focusMode={taskFocusMode}
          missionDetailId={bossMissionDetailId}
          focusSection={departmentFocusSection}
          boss={selectedDepartmentLead}
          workers={workerList}
          missions={missionList}
          legacyTasks={collaborationList}
          departmentRecord={selectedDepartment}
          onPrepare={prepareMission}
          onStart={startMission}
          onLoadThread={loadDepartmentThread}
          onMessageDepartment={messageDepartment}
          onResetSessions={resetDepartmentSessions}
          onCancel={cancelMission}
          onRetryReview={retryMissionReview}
          onApprovePlan={approveMissionPlan}
          onResolve={resolveMission}
          onResolveApproval={resolveMissionApproval}
          onAsk={askMission}
          onSelectWorker={activateNpc}
          onClose={() => { setSelectedDepartmentId(null); setBossMissionDetailId(null); setDepartmentFocusSection(null); }}
          composerHost={composerHost}
        />}
      </aside>

      <div ref={setComposerHostRef} className="unified-composer-host">
      {!bossAssignmentOpen && !selectedDepartment && <TaskComposer
        draftKey={activeSessionKey}
        placeholder={active?.busy ? t("{name} 執勤中·可排隊", { name: active.name }) : t("對 {name} 下指令（{tip}）", { name: active?.name ?? "…", tip: composerTips[tipIndex] })}
        submitLabel={t("執行")}
        disabled={!active || activeAuth.status !== "authenticated"}
        layout="dock"
        focusMode={taskFocusMode}
        focusRequest={composerFocusRequest}
        busy={Boolean(active?.busy)}
        queueEnabled
        persistExtras
        globalDrop={activeAuth.status === "authenticated" && !workspaceOpen && !commandCenterOpen && !avatarWorkerId && !handoffTarget && !personaWorkerId && !mcpModalOpen && !codexCommandsModalOpen && !accountsModalOpen}
        dropTargetLabel={active?.name}
        palette={{
          workspacePath: activeWorkspace,
          provider: activeProvider,
          capabilities: activeCapabilities,
          open: commandPaletteOpen,
          onOpenChange: setCommandPaletteOpen,
          onManage: () => { setCommandPaletteOpen(false); setCommandCenterOpen(true); },
        }}
        history={{ workers: workerList, provider: activeProvider, workspacePath: activeWorkspace }}
        toolbar={<>
          <button
            type="button"
            className={`composer-roundtable-toggle${discussionMode === "roundtable" ? " is-active" : ""}`}
            aria-pressed={discussionMode === "roundtable"}
            title={t("快速圓桌：由目前 NPC 單回合模擬 2–4 個觀點並直接給結論；不會啟動其他 Agent")}
            onClick={() => setDiscussionMode((mode) => toggleDiscussionMode(mode, "roundtable"))}
          >{t("🗣️ 快速圓桌")}{discussionMode === "roundtable" ? t("・開") : ""}</button>
          <button
            type="button"
            className={`composer-roundtable-toggle composer-roundtable-toggle--warroom${discussionMode === "warroom" ? " is-active" : ""}`}
            aria-pressed={discussionMode === "warroom"}
            title={t("作戰室：召集 2–4 位臨時 Claude NPC，進行 1–2 輪辯論再裁決；約需數分鐘並使用 Claude 用量")}
            onClick={() => setDiscussionMode((mode) => toggleDiscussionMode(mode, "warroom"))}
          >{t("🏛️ 作戰室")}{discussionMode === "warroom" ? t("・開") : ""}</button>
          <div className="composer-roundtable-more" ref={roundtableMenuRef}>
            <button
              type="button"
              className="composer-roundtable-toggle composer-roundtable-toggle--more"
              aria-expanded={roundtableMenuOpen}
              aria-label={t("作戰室更多選項")}
              title={t("作戰室更多選項：自訂角色、歷史")}
              onClick={() => setRoundtableMenuOpen((open) => !open)}
            >⋯</button>
            {roundtableMenuOpen && <div className="composer-roundtable-menu" role="menu">
              <button type="button" role="menuitem" onClick={() => { setRoundtableMenuOpen(false); setStancesOpen(true); }}>{t("⚙ 自訂角色")}</button>
              <button type="button" role="menuitem" onClick={() => { setRoundtableMenuOpen(false); void openWarroomHistory(); }}>{t("📜 歷史")}</button>
            </div>}
          </div>
          {stancesOpen && <div className="warroom-stances-panel">
            <header><strong>{t("⚙ 自訂作戰室角色")}</strong><button type="button" onClick={() => setStancesOpen(false)} aria-label={t("關閉")}>×</button></header>
            <textarea
              value={stancesText}
              rows={4}
              placeholder={t("每行一位：角色名｜立場描述\n例：投資顧問｜從報酬與機會出發給建議\n　　風控｜專挑風險與下檔情境\n留空＝依難度自動配（提案/挑戰/權衡/查證）")}
              onChange={(event) => { setStancesText(event.target.value); localStorage.setItem("warroom-stances", event.target.value); }}
            />
            <small>{parseCustomStances(stancesText).length > 0 ? t("將使用自訂 {count} 位角色（上限 4）", { count: String(parseCustomStances(stancesText).length) }) : t("目前使用預設角色")}</small>
          </div>}
        </>}
        onSubmit={async (command) => {
          if (!activeId) return t("沒有可用的人員");
          const submissionMode = discussionSubmission(discussionMode, command.text);
          if (submissionMode === "roundtable") {
            return send(activeId, { ...command, text: roundtablePrompt(command.text) });
          }
          if (submissionMode !== "warroom") return send(activeId, command);
          // 作戰室：呼叫後端 orchestrator——會自動冒出 3 個 🏛 角色 NPC 走到會議桌，兩輪辯論（表態→反駁）、
          // 主持用較強模型裁決，跑完自動散會刪除。回傳結構化裁決顯示在結果卡。過程幾分鐘，畫面上看得到。
          if (warroomRunning) { notify(t("作戰室討論中，請等這場結束…"), "info"); return null; }
          setWarroomRunning(true);
          notify(t("🏛️ 作戰室開議：成員正走向會議桌辯論，約需幾分鐘…"), "info");
          try {
            const resp = await apiRequest<{ ok: boolean; result: WarRoomResult }>("/api/warroom", {
              method: "POST",
              body: { topic: command.text, difficulty: "auto", workspacePath: activeWorkspace, hostWorkerId: activeId, stances: parseCustomStances(stancesText) },
              // 後端整場會議封頂 12 分鐘；多留 1 分鐘讓它完成清理並回傳 HTTP 結果。
              timeoutMs: 13 * 60_000,
            });
            setWarroomResult(resp.result);
          } catch (error) {
            notify(error instanceof Error ? error.message : t("作戰室失敗"), "error");
          } finally {
            setWarroomRunning(false);
          }
          return null;
        }}
        onInterrupt={() => {
          if (!activeId) return;
          void interrupt(activeId).then((error) => error ? notify(error, "error") : notify(t("已送出中止要求"), "info"));
        }}
      />}
      </div>
      </div>

      <WorkerTabs
        workers={workerList}
        activeId={activeId}
        departments={departmentList}
        missions={missionList}
        selectedDepartmentId={selectedDepartmentId}
        currentRoom={activeWorkspace}
        filter={preferences.crewFilter}
        collapsed={preferences.crewRailCollapsed}
        onFilter={(crewFilter) => updatePreferences({ crewFilter })}
        onCollapsed={(crewRailCollapsed) => updatePreferences({ crewRailCollapsed })}
        onSelect={activateNpc}
        onSelectDepartment={selectDepartment}
        onReorder={(ids) => { void reorderWorkers(ids).then((error) => { if (error) notify(error, "error"); }); }}
        onCreate={() => openWorkspaceForCreate(activeProvider)}
        onCreateDepartment={() => setDepartmentCreatorOpen(true)}
        onClose={handleRemoveWorker}
        onRename={handleRename}
        onAvatar={setAvatarWorkerId}
        onPersona={setPersonaWorkerId}
        onRoom={(id) => { setActiveId(id); openWorkspaceForMove(); }}
      />

      {commandCenterOpen && activeWorkspace && <Suspense fallback={<div className="command-center command-center--loading"><div className="ui-skeleton"><i /><i /><i /></div></div>}><CommandCenter workspacePath={activeWorkspace} provider={activeProvider} workers={workerList} activeWorkerId={activeId} revisions={{ claude: workflowRevisions[`claude\0${activeWorkspace}`] ?? 0, codex: workflowRevisions[`codex\0${activeWorkspace}`] ?? 0 }} onRun={async (workerId, message) => { const runError = await send(workerId, { text: message, images: [], documents: [] }); if (!runError) setActiveId(workerId); return runError; }} onClose={() => setCommandCenterOpen(false)} /></Suspense>}

      {!workspaceSetupRequired && <AuthGate
        auth={activeAuth}
        providers={auth}
        installs={providerInstalls}
        platform={system?.platform}
        defaultCodexLogin={defaultCodexLogin}
        onStartDefaultCodexLogin={async (mode, apiKey) => {
          const error = await startDefaultCodexLogin(mode, apiKey);
          if (error) notify(error, "error");
          return error;
        }}
        onCancelDefaultCodexLogin={cancelDefaultCodexLogin}
        defaultClaudeLogin={defaultClaudeLogin}
        onStartDefaultClaudeLogin={async () => {
          const error = await startDefaultClaudeLogin();
          if (error) notify(error, "error");
          return error;
        }}
        onSubmitDefaultClaudeLoginCode={async (code) => {
          const error = await submitDefaultClaudeLoginCode(code);
          if (error) notify(error, "error");
          return error;
        }}
        onCancelDefaultClaudeLogin={cancelDefaultClaudeLogin}
        onRefresh={refreshAuth}
        onInstall={installProvider}
        onUseProvider={(provider) => {
          if (active) void changeProvider(provider);
          else openWorkspaceForCreate(provider);
        }}
      />}

      {workspaceOpen && <WorkspacePicker required={workspaceSetupRequired} mode={workspaceMode} currentPath={activeWorkspace} recentPaths={workspacePaths} resetsConversation={workspaceMode === "move" && Boolean(active?.turns.length)} newWorkerProvider={newWorkerProvider} accounts={Object.values(accounts)} accountId={newWorkerAccountId} onAccountChange={setNewWorkerAccountId} onBrowse={pickWorkspace} onClose={() => setWorkspaceOpen(false)} onSelect={async (path) => {
        if (workspaceMode === "create") {
          const result = await createWorker(undefined, newWorkerProvider, path, undefined, newWorkerAccountId);
          if (!result.error) notify(t("新工位建造中"));
          return result.error ?? null;
        }
        if (!activeId) return t("請先選擇要搬遷的 NPC");
        const error = await switchWorkspace(activeId, path);
        if (!error) notify(t("人員已搬到新房間"));
        return error;
      }} />}

      <Suspense fallback={null}>
      {avatarWorkerId && workers[avatarWorkerId] && <AvatarWorkshop worker={workers[avatarWorkerId]} onSave={async (id, data, mime) => { const error = await saveAvatar(id, data, mime); if (!error) notify(t("自訂角色已套用")); return error; }} onPreset={async (id, presetId) => { const error = await selectAvatarPreset(id, presetId); if (!error) notify(t("官方角色已套用")); return error; }} onActivateCustom={async (id) => { const error = await activateCustomAvatar(id); if (!error) notify(t("已切回自訂角色")); return error; }} onReset={async (id) => { const error = await resetAvatar(id); if (!error) notify(t("已刪除自訂角色並恢復經典隊員")); return error; }} onClose={() => setAvatarWorkerId(null)} />}

      {handoffTarget && active && <ProviderHandoffDialog key={`${active.id}:${handoffTarget}`} worker={active} toProvider={handoffTarget} onPrepare={prepareHandoff} onStart={startHandoff} onDirectSwitch={switchProviderFresh} onClose={() => setHandoffTarget(null)} />}

      {personaWorkerId && workers[personaWorkerId] && <PersonaEditor worker={workers[personaWorkerId]} onSave={async (id, persona) => { const error = await setPersona(id, persona); if (!error) notify(persona ? t("個性已更新，下一句話生效") : t("已清除個性")); return error; }} onClose={() => setPersonaWorkerId(null)} />}

      {departmentCreatorOpen && <DepartmentCreator
        initialProvider={activeProvider}
        initialWorkspacePath={activeWorkspace}
        recentPaths={workspacePaths}
        providers={auth}
        maxMembers={Math.max(0, 20 - workerList.length)}
        onBrowse={pickWorkspace}
        onCreated={(ids, purpose) => {
          if (ids.length) setActiveId(ids[ids.length - 1]);
          setDepartmentCreatorOpen(false);
          notify(t("「{purpose}」部門已建立，共 {count} 位 NPC", { purpose, count: String(ids.length) }));
        }}
        onClose={() => setDepartmentCreatorOpen(false)}
      />}

      {mcpModalOpen && <McpModal capabilities={activeCapabilities} provider={activeProvider} workspacePath={activeWorkspace} mcpLoginResult={mcpLoginResult} platform={system?.platform} usedMcpTools={usedMcpTools} notify={notify} onClose={() => setMcpModalOpen(false)} />}
      {codexCommandsModalOpen && <CodexCommandsModal capabilities={capabilitiesByWorkspace[activeWorkspace]?.codex ?? EMPTY_CAPABILITIES} onClose={() => setCodexCommandsModalOpen(false)} />}
      {accountsModalOpen && <AccountsModal
        accounts={Object.values(accounts)}
        accountLogins={accountLogins}
        onCreate={createAccount}
        onDelete={deleteAccount}
        onRefresh={refreshAccount}
        onLogin={startAccountLogin}
        onSubmitLoginCode={submitAccountLoginCode}
        onCancelLogin={cancelAccountLogin}
        onClose={() => setAccountsModalOpen(false)}
        initialProvider={activeProvider}
        defaultAuth={auth}
        defaultCodexLogin={defaultCodexLogin}
        defaultClaudeLogin={defaultClaudeLogin}
        onRefreshDefaultAuth={refreshAuth}
        onStartDefaultCodexLogin={startDefaultCodexLogin}
        onCancelDefaultCodexLogin={cancelDefaultCodexLogin}
        onStartDefaultClaudeLogin={startDefaultClaudeLogin}
        onSubmitDefaultClaudeLoginCode={submitDefaultClaudeLoginCode}
        onCancelDefaultClaudeLogin={cancelDefaultClaudeLogin}
      />}
      {backupModalOpen && <BackupModal notify={notify} onClose={() => setBackupModalOpen(false)} />}
      {opsModalOpen && <OpsModal workers={workerList} notify={notify} onClose={() => setOpsModalOpen(false)} />}
      {remoteModalOpen && <RemoteAccessModal notify={notify} onClose={() => setRemoteModalOpen(false)} />}
      {kanbanModalOpen && <KanbanModal workers={workerList} onOpenBoss={openBossDesk} onClose={() => setKanbanModalOpen(false)} />}
      {dayReportOpen && <DayReportModal notify={notify} onClose={() => setDayReportOpen(false)} />}
      {outboxOpen && <OutboxModal onClose={() => setOutboxOpen(false)} />}
      {shortcutsHelpOpen && <ShortcutsHelp onClose={() => setShortcutsHelpOpen(false)} />}
      {tourOpen && <OnboardingTour onClose={() => setTourOpen(false)} />}
      </Suspense>

      {pendingAutoApproveMode && <Modal
        label={t("確認啟用無限制自動核准")}
        overlayClassName="auto-approve-confirm"
        cardClassName="auto-approve-confirm__card"
        closeClassName="auto-approve-confirm__close"
        closeLabel={t("取消啟用無限制模式")}
        onClose={() => setPendingAutoApproveMode(null)}
      >
        <header>
          <span>⚠ {t("高風險權限變更")}</span>
          <h2>{t("啟用 ⚡ 無限制模式？")}</h2>
          <p>{t("這會讓 {name} 略過所有核准，包含刪除檔案、提權 Bash 指令與 MCP 的外部動作。", { name: pendingAutoApproveMode.workerName })}</p>
        </header>
        <dl className="auto-approve-confirm__scope">
          <div><dt>{t("NPC")}</dt><dd>{pendingAutoApproveMode.workerName}</dd></div>
          <div><dt>{t("工作區")}</dt><dd title={pendingAutoApproveMode.workspacePath}>{pendingAutoApproveMode.workspacePath}</dd></div>
        </dl>
        <p className="auto-approve-confirm__warning">{t("此設定會持續套用到這位 NPC，直到你主動切回其他模式。")}</p>
        <div className="auto-approve-confirm__actions">
          <button type="button" onClick={() => setPendingAutoApproveMode(null)}>{t("取消")}</button>
          <button type="button" className="auto-approve-confirm__danger" onClick={confirmAutoApproveMode}>{t("我了解風險，啟用")}</button>
        </div>
      </Modal>}

      {warroomRunning && <div className="warroom-running" role="status" aria-live="polite">
        <span className="warroom-running__dot" aria-hidden="true" />
        {t("🏛️ 作戰室辯論進行中…成員正在會議桌交鋒，結果會自動送回")}
      </div>}

      {warroomResult && <div className="warroom-result" role="dialog" aria-modal="true" aria-label={t("作戰室裁決")}>
        <div className="warroom-result__card">
          <button type="button" className="warroom-result__close" onClick={() => setWarroomResult(null)} aria-label={t("關閉")}>×</button>
          <header><span>🏛️ WAR ROOM{typeof warroomResult.costUsd === "number" ? ` · ${t("本場花費 ${amount}", { amount: warroomResult.costUsd.toFixed(4) })}` : ""}</span><h2>{t("作戰室裁決")}</h2></header>
          <WarroomVerdictBody result={warroomResult} />
        </div>
      </div>}

      {warroomHistory && <div className="warroom-result" role="dialog" aria-modal="true" aria-label={t("作戰室歷史")}>
        <div className="warroom-result__card">
          <button type="button" className="warroom-result__close" onClick={() => { setWarroomHistory(null); setWarroomHistoryContent(null); }} aria-label={t("關閉")}>×</button>
          <header><span>🏛️ WAR ROOM</span><h2>{t("📜 作戰室歷史")}</h2></header>
          {warroomHistoryContent
            ? <>
                <button type="button" className="warroom-history__back" onClick={() => setWarroomHistoryContent(null)}>{t("← 回列表")}</button>
                {warroomHistoryContent.report?.result
                  ? <>
                      {warroomHistoryContent.report.topic && <p className="warroom-history__topic">{t("主題：")}{warroomHistoryContent.report.topic}{warroomHistoryContent.report.difficulty ? ` · ${warroomHistoryContent.report.difficulty}` : ""}</p>}
                      <WarroomVerdictBody result={warroomHistoryContent.report.result} />
                    </>
                  : <div className="warroom-history__content">
                      {/* 完整 Markdown 渲染（RichText 已在主包）：巢狀清單/表格/粗體都吃得下，
                          不再用手刻的逐行 #/##/- 解析。 */}
                      <RichText text={warroomHistoryContent.content} compact />
                    </div>}
              </>
            : warroomHistory.length === 0
              ? <p className="warroom-result__note">{t("還沒有任何報告——開一場作戰室就會自動存檔到這裡。")}</p>
              : <ul className="warroom-history__list">{warroomHistory.map((r) => (
                  <li key={r.file}>
                    <button type="button" className="warroom-history__item" onClick={() => {
                      void apiRequest<{ ok: boolean; content: string; report?: { topic?: string; difficulty?: string; result?: WarRoomResult } | null }>(`/api/warroom/history/${encodeURIComponent(r.file)}?workspacePath=${encodeURIComponent(activeWorkspace)}`)
                        .then((resp) => setWarroomHistoryContent({ file: r.file, content: resp.content, report: resp.report ?? null }))
                        .catch((error) => notify(error instanceof Error ? error.message : t("讀取失敗"), "error"));
                    }}>
                      <strong>{r.topic || r.file}</strong>
                      <small>{r.file.replace(/^warroom-|\.md$/g, "").replace("T", " ").slice(0, 19)}{r.difficulty ? ` · ${r.difficulty}` : ""}</small>
                    </button>
                    <button type="button" className="warroom-history__delete" aria-label={t("刪除 {topic}", { topic: r.topic || r.file })} onClick={() => {
                      void apiRequest(`/api/warroom/history/${encodeURIComponent(r.file)}?workspacePath=${encodeURIComponent(activeWorkspace)}`, { method: "DELETE" })
                        .then(() => setWarroomHistory((list) => list?.filter((x) => x.file !== r.file) ?? null))
                        .catch((error) => notify(error instanceof Error ? error.message : t("刪除失敗"), "error"));
                    }}>🗑</button>
                  </li>
                ))}</ul>}
        </div>
      </div>}

      <footer className="app-copyright" aria-label={t("版權資訊")}>© 2026 weiwei</footer>
      <ToastRegion toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}
