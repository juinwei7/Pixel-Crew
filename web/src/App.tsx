import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useWorkers } from "./hooks/useWorkers";
import { topDismissibleLayer, useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import { useUiPreferences, clampTaskLogWidth, enteredCompactOffice } from "./uiPreferences";
import { GameCanvas } from "./components/GameCanvas";
import { QuestLog } from "./components/QuestLog";
import { WorkerTabs } from "./components/WorkerTabs";
import { TopBar } from "./components/TopBar";
import { TaskComposer } from "./components/TaskComposer";
import { ToastRegion, type Toast } from "./components/ToastRegion";
import { EnergyHud, FocusEnergy } from "./components/EnergyHud";
import { AuthGate } from "./components/AuthGate";
import { WorkspacePicker } from "./components/WorkspacePicker";
import { AvatarWorkshop } from "./components/AvatarWorkshop";
import { ProviderHandoffDialog } from "./components/ProviderHandoffDialog";
import { DepartmentMissionDialog } from "./components/DepartmentMissionDialog";
import { PersonaEditor } from "./components/PersonaEditor";
import { DepartmentCreator } from "./components/DepartmentCreator";
import { McpModal } from "./components/McpModal";
import { BackupModal } from "./components/BackupModal";
import { BossTaskDesk } from "./components/BossTaskDesk";
import { FocusControls } from "./components/FocusControls";
import { ModelSwitchCard } from "./components/ModelSwitchCard";
import { parseMcpToolName } from "./mcpToolName";
import { diffNotifications, snapshotWorker, type WorkerSnapshot } from "./notifications";
import { latestReadableTurnKey, workerFocusStatus } from "./crew";
import type { AutoApproveMode, ProviderId } from "./types";

const CommandCenter = lazy(() => import("./components/CommandCenter").then((module) => ({
  default: module.CommandCenter,
})));

const CLAUDE_MODEL_OPTIONS = [
  { id: "opus", label: "Opus" },
  { id: "sonnet", label: "Sonnet" },
  { id: "haiku", label: "Haiku（最快）" },
  { id: "fable", label: "Fable" },
];

function mergeModelOptions(fallback: typeof CLAUDE_MODEL_OPTIONS, discovered: typeof CLAUDE_MODEL_OPTIONS, activeModel?: string | null) {
  const models = new Map<string, { id: string; label: string; description?: string }>();
  for (const model of fallback) models.set(model.id, model);
  for (const model of discovered) models.set(model.id, model);
  if (activeModel && !models.has(activeModel)) models.set(activeModel, { id: activeModel, label: activeModel });
  return [{ id: "", label: "預設模型" }, ...models.values()];
}

const EMPTY_CAPABILITIES = {
  slashCommands: [], mcpServers: [], models: [], toolCount: null, builtinTools: null, loading: true,
  source: "empty" as const, updatedAt: null, error: null,
};

export function App() {
  const {
    workers, bossTasks, collaborations, missions, departments, order, mcpLoginResult, activeId, setActiveId, targetRepoPath, system, stats, updateInfo, workspacePaths, wsReady,
    capabilitiesByWorkspace, workflowRevisions, auth, providerUsage, providerInstalls, createWorker, pickWorkspace,
    switchWorkspace, closeWorker, renameWorker, reorderWorkers, saveAvatar, resetAvatar, selectAvatarPreset, activateCustomAvatar, prepareHandoff, startHandoff, switchProviderFresh,
    prepareMission, startMission, loadDepartmentThread, messageDepartment, resetDepartmentSessions, renameDepartment, createBossTask, messageBossTask, updateBossTask, deleteBossTask, cancelMission, retryMissionReview, approveMissionPlan, resolveMission,
    send, askMission, setModel, setModelFresh, setPersona, setAutoApproveMode, interrupt, resolveApproval, resolveMissionApproval, refreshAuth, refreshUsage, installProvider,
  } = useWorkers();
  const { preferences, updatePreferences, resetPreferences } = useUiPreferences();
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [workspaceMode, setWorkspaceMode] = useState<"create" | "move">("move");
  const [newWorkerProvider, setNewWorkerProvider] = useState<ProviderId>("claude");
  const [commandCenterOpen, setCommandCenterOpen] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [avatarWorkerId, setAvatarWorkerId] = useState<string | null>(null);
  const [handoffTarget, setHandoffTarget] = useState<ProviderId | null>(null);
  const [selectedDepartmentId, setSelectedDepartmentId] = useState<string | null>(null);
  const [bossMissionDetailId, setBossMissionDetailId] = useState<string | null>(null);
  const [departmentFocusSection, setDepartmentFocusSection] = useState<"team" | "history" | null>(null);
  const [providerChanging, setProviderChanging] = useState(false);
  const [personaWorkerId, setPersonaWorkerId] = useState<string | null>(null);
  const [departmentCreatorOpen, setDepartmentCreatorOpen] = useState(false);
  const [mcpModalOpen, setMcpModalOpen] = useState(false);
  const [backupModalOpen, setBackupModalOpen] = useState(false);
  const [bossAssignmentOpen, setBossAssignmentOpen] = useState(false);
  const [pendingModelSwitch, setPendingModelSwitch] = useState<{ workerId: string; model: string } | null>(null);
  const [modelSwitchSubmitting, setModelSwitchSubmitting] = useState(false);
  const [taskSearchOpen, setTaskSearchOpen] = useState(false);
  const [taskSearch, setTaskSearch] = useState("");
  const [taskSearchScope, setTaskSearchScope] = useState<"current" | "all">("current");
  const taskFocusMode = preferences.taskFocusMode;
  const [focusUsageOpen, setFocusUsageOpen] = useState(false);
  const [focusSeenTurns, setFocusSeenTurns] = useState<Record<string, string | null>>({});
  const [composerFocusRequest, setComposerFocusRequest] = useState(0);
  const [composerHost, setComposerHost] = useState<HTMLDivElement | null>(null);
  const setComposerHostRef = useCallback((node: HTMLDivElement | null) => setComposerHost(node), []);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  const focusLayerRef = useRef<HTMLDivElement>(null);
  const focusExitRef = useRef<HTMLButtonElement>(null);
  const focusReturnRef = useRef<HTMLElement | null>(null);

  const workerList = order.map((id) => workers[id]).filter(Boolean);
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

  const dismissToast = useCallback((id: string) => setToasts((current) => current.filter((toast) => toast.id !== id)), []);
  const notify = useCallback((message: string, tone: Toast["tone"] = "ok") => {
    setToasts((current) => [...current.slice(-3), { id: `${Date.now()}-${Math.random()}`, message, tone }]);
  }, []);

  const activateNpc = useCallback((id: string) => {
    setActiveId(id);
    setSelectedDepartmentId(null);
    setBossMissionDetailId(null);
    setBossAssignmentOpen(false);
    updatePreferences({ taskLogOpen: true });
    setComposerFocusRequest((request) => request + 1);
  }, [setActiveId, updatePreferences]);

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
      notify("這個瀏覽器不支援桌面通知", "error");
      return;
    }
    void Notification.requestPermission().then((permission) => {
      if (permission === "granted") {
        updatePreferences({ notificationsEnabled: true });
        notify("桌面通知已開啟：任務完成或等待核准時通知（分頁在背景才會跳）");
      } else {
        notify("瀏覽器未授權通知，請在網址列旁的權限設定允許", "error");
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
    updatePreferences({ taskLogOpen: true, taskFocusMode: true });
  }, [updatePreferences, workerList]);

  const exitTaskFocusMode = useCallback(() => {
    setFocusUsageOpen(false);
    updatePreferences({ taskFocusMode: false });
  }, [updatePreferences]);

  const shortcuts = useMemo(() => ({
    onCommandPalette: () => setCommandPaletteOpen(true),
    onToggleTaskLog: () => taskFocusMode
      ? exitTaskFocusMode()
      : updatePreferences({ taskLogOpen: !preferences.taskLogOpen }),
    onApproval: () => {
      if (!approvalWorker) return;
      setActiveId(approvalWorker.id);
      setSelectedDepartmentId(null);
      setBossMissionDetailId(null);
      updatePreferences({ taskLogOpen: true });
    },
    onEscape: () => {
      // These overlays already have their own Escape-to-close handling and can be
      // reached from inside focus mode; without this guard, closing one of them
      // would also silently exit focus mode via the layer check below.
      const overlayModalOpen = workspaceOpen || departmentCreatorOpen || commandCenterOpen || mcpModalOpen || backupModalOpen
        || Boolean(avatarWorkerId) || Boolean(handoffTarget) || Boolean(personaWorkerId);
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
  }), [approvalWorker, avatarWorkerId, backupModalOpen, commandCenterOpen, commandPaletteOpen, departmentCreatorOpen, exitTaskFocusMode, handoffTarget, mcpModalOpen, personaWorkerId, preferences.taskLogOpen, setActiveId, taskFocusMode, taskSearchOpen, updatePreferences, workspaceOpen]);
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

  useEffect(() => {
    if (!taskFocusMode || !active) return;
    const latestKey = latestReadableTurnKey(active);
    setFocusSeenTurns((current) => current[active.id] === latestKey ? current : { ...current, [active.id]: latestKey });
  }, [active, taskFocusMode]);

  useEffect(() => () => resizeCleanupRef.current?.(), []);

  useEffect(() => {
    let previousWidth = window.innerWidth;
    const preserveOffice = () => {
      const currentWidth = window.innerWidth;
      if (enteredCompactOffice(previousWidth, currentWidth)) {
        updatePreferences({ taskLogOpen: false });
      }
      previousWidth = currentWidth;
    };
    window.addEventListener("resize", preserveOffice);
    return () => window.removeEventListener("resize", preserveOffice);
  }, [updatePreferences]);

  function beginPanelResize(event: React.PointerEvent<HTMLButtonElement>) {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = preferences.taskLogWidth;
    const move = (moveEvent: PointerEvent) => updatePreferences({
      taskLogWidth: clampTaskLogWidth(startWidth + startX - moveEvent.clientX, window.innerWidth),
    });
    const cleanup = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", cleanup);
      window.removeEventListener("pointercancel", cleanup);
      resizeCleanupRef.current = null;
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
        notify(prepared.error || "無法檢查目標 LLM", "error");
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
      else notify(`正在切換至 ${provider === "claude" ? "Claude Code" : "Codex"}`, "info");
      return;
    }
    setHandoffTarget(provider);
  }

  async function handleRename(id: string, name: string) {
    const error = await renameWorker(id, name);
    if (!error) notify("人員名稱已更新");
    return error;
  }

  function handleRemoveWorker(id: string) {
    const name = workers[id]?.name;
    if (!window.confirm(name ? `確定永久移除「${name}」嗎？工位與完整對話紀錄都會一併拆除，此動作無法復原。` : "確定永久移除這位 NPC 嗎？此動作無法復原。")) return;
    void closeWorker(id).then((error) => error ? notify(error, "error") : notify("人員與工位拆除中", "info"));
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
      notify(fresh ? "已切換模型並開啟全新工作階段" : "模型設定已更新");
    });
  }

  function handleAutoApproveChange(mode: AutoApproveMode) {
    if (!activeId) return;
    void setAutoApproveMode(activeId, mode).then((error) => {
      if (error) { notify(error, "error"); return; }
      if (mode === "off") notify("自動核准已關閉");
      else if (mode === "safe") notify("安全自動核准已開啟；只有唯讀與驗證安全的指令會跳過詢問");
      else notify("完全自動核准已開啟；rm -rf、sudo 等高風險指令仍會詢問");
    });
  }

  return (
    <div className={`game-root ${taskFocusMode ? "game-root--focus" : ""} ${preferences.taskLogOpen ? "game-root--task-log-open" : ""} ${preferences.crewRailCollapsed ? "game-root--crew-collapsed" : ""}`} style={{
      "--log-panel-width": `${preferences.taskLogWidth}px`,
    } as CSSProperties}>
      <GameCanvas
        workers={workerList}
        activeId={activeId}
        completedTurns={stats.completedTurns}
        collaborations={Object.values(collaborations)}
        missions={Object.values(missions)}
        departments={Object.values(departments)}
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

      <TopBar
        active={active}
        activeWorkspace={activeWorkspace}
        capabilities={activeCapabilities}
        auth={activeAuth}
        wsReady={wsReady}
        modelOptions={modelOptions}
        workerCount={workerList.length}
        providerChanging={providerChanging}
        onRoom={() => active ? openWorkspaceForMove() : openWorkspaceForCreate(activeProvider)}
        onBossAssignment={() => { setBossAssignmentOpen(true); setSelectedDepartmentId(null); setBossMissionDetailId(null); setTaskSearchOpen(false); updatePreferences({ taskLogOpen: true }); }}
        onOpenMcp={() => setMcpModalOpen(true)}
        onOpenBackup={() => setBackupModalOpen(true)}
        onProvider={(provider) => void changeProvider(provider)}
        onModel={handleModelChange}
        onAutoApprove={handleAutoApproveChange}
        onRefreshAuth={() => void refreshAuth(activeProvider)}
        onResetUi={() => { resetPreferences(); notify("介面配置已重設", "info"); }}
        notificationsEnabled={preferences.notificationsEnabled}
        onNotificationsToggle={toggleNotifications}
        updateInfo={updateInfo}
      />

      {!taskFocusMode && <EnergyHud usage={providerUsage} onRefresh={refreshUsage} totalCostUsd={stats.totalCostUsd} />}

      {!wsReady && <div className="system-banner system-banner--error" role="alert"><i />本機服務重新連線中，現有畫面會保留。</div>}
      {wsReady && activeProvider === "codex" && system?.codexWindowsBestEffort && <div className="system-banner" role="status"><i />Windows 10 可使用 Codex，但原生沙箱屬上游 best-effort；Windows 11 會更穩定。</div>}

      <button className={`panel-toggle ${preferences.taskLogOpen ? "panel-toggle--open" : ""}`} onClick={() => updatePreferences({ taskLogOpen: !preferences.taskLogOpen })} title={`${preferences.taskLogOpen ? "收合" : "展開"}任務日誌（⌘/Ctrl J）`} aria-label={`${preferences.taskLogOpen ? "收合" : "展開"}任務日誌`}>
        {preferences.taskLogOpen ? "▶" : "◀"}
      </button>

      <div
        ref={focusLayerRef}
        className="task-focus-layer"
        aria-label={taskFocusMode ? "專心閱讀與輸入" : undefined}
        aria-modal={taskFocusMode || undefined}
        role={taskFocusMode ? "dialog" : undefined}
        onKeyDown={trapFocusInReader}
      >
      <aside
        className={`holo-panel ${preferences.taskLogOpen ? "" : "holo-panel--closed"} ${taskFocusMode ? "holo-panel--focus" : ""}`}
        aria-label={taskFocusMode ? "專心閱讀任務報告" : "任務日誌"}
      >
        {!taskFocusMode && <button type="button" className="holo-panel__resize" aria-label="調整任務日誌寬度" title="拖曳調整；雙擊恢復閱讀版" onPointerDown={beginPanelResize} onDoubleClick={() => updatePreferences({ taskLogWidth: 600 })} onKeyDown={(event) => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          event.preventDefault();
          updatePreferences({ taskLogWidth: preferences.taskLogWidth + (event.key === "ArrowLeft" ? 24 : -24) });
        }} />}
        <div className="holo-panel__title">
          <div className="holo-panel__heading"><span className="holo-panel__eyebrow">{bossAssignmentOpen ? taskFocusMode ? "FOCUS BOSS DESK" : "BOSS DESK" : taskFocusMode ? selectedDepartment ? "FOCUS DEPARTMENT" : "FOCUS READER" : selectedDepartment ? "DEPARTMENT WORK" : "WORKSTREAM"}</span><strong>{bossAssignmentOpen ? "老闆交辦" : taskFocusMode ? selectedDepartment ? "專注部門" : "專心閱讀" : selectedDepartment ? selectedDepartment.name : "任務日誌"}</strong></div>
          {taskFocusMode ? <div className="focus-context-switch">
            <div className="focus-context-switch__kind" aria-label="專注模式工作對象">
              <button type="button" className={!selectedDepartment && !bossAssignmentOpen ? "active" : ""} onClick={() => activeId && activateNpc(activeId)}>NPC</button>
              <button type="button" className={selectedDepartment ? "active" : ""} disabled={Object.keys(departments).length === 0} onClick={() => selectedDepartmentId ? selectDepartment(selectedDepartmentId) : Object.keys(departments)[0] && selectDepartment(Object.keys(departments)[0])}>部門</button>
              <button type="button" className={bossAssignmentOpen ? "active" : ""} onClick={() => { setBossAssignmentOpen(true); setSelectedDepartmentId(null); setBossMissionDetailId(null); }}>老闆</button>
            </div>
            {!bossAssignmentOpen && (!selectedDepartment ? <label className="focus-worker-switch">
              <span>NPC</span>
              <select aria-label="切換專心模式的 NPC 工作介面" value={activeId ?? ""} onChange={(event) => activateNpc(event.target.value)}>
                {!activeId && <option value="" disabled>選擇 NPC</option>}
                {Object.values(departments).map((department) => <optgroup key={department.id} label={department.name}>{workerList.filter((worker) => worker.departmentId === department.id).map((worker) => {
                  const latestKey = latestReadableTurnKey(worker);
                  const unread = worker.id !== activeId && Boolean(latestKey) && latestKey !== focusSeenTurns[worker.id];
                  return <option key={worker.id} value={worker.id}>{unread ? "● " : ""}{worker.name} · {worker.provider === "claude" ? "Claude" : "Codex"} · {workerFocusStatus(worker)}</option>;
                })}</optgroup>)}
                {workerList.filter((worker) => !worker.departmentId || !departments[worker.departmentId]).map((worker) => <option key={worker.id} value={worker.id}>{worker.name} · {workerFocusStatus(worker)}</option>)}
              </select>
            </label> : <label className="focus-worker-switch focus-department-switch"><span>部門</span><select aria-label="切換專心模式的部門工作介面" value={selectedDepartment.id} onChange={(event) => selectDepartment(event.target.value)}>{Object.values(departments).map((department) => {
              const mission = Object.values(missions).find((candidate) => candidate.departmentId === department.id && ["planning", "executing", "reviewing", "needs_attention"].includes(candidate.status));
              return <option key={department.id} value={department.id}>{department.name}{mission ? ` · ${mission.status === "needs_attention" ? "需處理" : "進行中"}` : " · 待命"}</option>;
            })}</select></label>)}
          </div> : bossAssignmentOpen ? <span className="holo-panel__worker holo-panel__department"><i />依部門職責與 NPC 職務自動路由</span> : selectedDepartment ? <span className="holo-panel__worker holo-panel__department"><i />{selectedDepartment.memberWorkerIds.length} 位 NPC · {selectedDepartment.purpose}</span> : active && <span className="holo-panel__worker"><i />{active.name}</span>}
          {taskFocusMode && <FocusEnergy usage={providerUsage} onRefresh={refreshUsage} totalCostUsd={stats.totalCostUsd} activeProvider={activeProvider} open={focusUsageOpen} onOpenChange={setFocusUsageOpen} />}
          <div className="task-log-toolbar">
            {!taskFocusMode && !selectedDepartment && !bossAssignmentOpen && <div className="task-log-toolbar__view" aria-label="日誌模式">
              <button type="button" className={preferences.taskLogView === "summary" ? "active" : ""} onClick={() => updatePreferences({ taskLogView: "summary" })}>摘要</button>
              <button type="button" className={preferences.taskLogView === "activity" ? "active" : ""} onClick={() => updatePreferences({ taskLogView: "activity" })}>活動</button>
            </div>}
            {!selectedDepartment && !bossAssignmentOpen && <button type="button" className={`task-log-toolbar__search ${taskSearchOpen ? "active" : ""}`} onClick={() => setTaskSearchOpen((open) => !open)} aria-label="搜尋任務日誌" title="搜尋">
              <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="5.5" /><path d="m15 15 4.5 4.5" /></svg>
            </button>}
            {!taskFocusMode && <button type="button" className="task-log-toolbar__focus" onClick={enterTaskFocusMode} aria-label="進入專心閱讀模式" title="專心閱讀"><span aria-hidden="true">▣</span> 專心</button>}
            {!taskFocusMode && <select aria-label="日誌寬度" value={preferences.taskLogWidth < 510 ? "420" : preferences.taskLogWidth > 720 ? "820" : "600"} onChange={(event) => updatePreferences({ taskLogWidth: Number(event.target.value) })}>
              <option value="420">緊湊</option><option value="600">閱讀</option><option value="820">寬版</option>
            </select>}
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
              onOpenBackup={() => setBackupModalOpen(true)}
              onNotificationsToggle={toggleNotifications}
              onOpenCommandCenter={() => { setCommandPaletteOpen(false); setCommandCenterOpen(true); }}
            />}
            {taskFocusMode && <button ref={focusExitRef} type="button" className="task-log-toolbar__exit" onClick={exitTaskFocusMode} aria-label="退出專心閱讀模式">退出 <kbd>Esc</kbd></button>}
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
        {!bossAssignmentOpen && !selectedDepartment && taskSearchOpen && <div className="task-log-search"><span className="task-log-search__icon"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="5.5" /><path d="m15 15 4.5 4.5" /></svg></span><input value={taskSearch} autoFocus placeholder={taskSearchScope === "current" ? "搜尋目前 NPC 的任務" : "搜尋全部 NPC 的任務"} onChange={(event) => setTaskSearch(event.target.value)} /><div className="task-log-search__scope" aria-label="搜尋範圍"><button type="button" className={taskSearchScope === "current" ? "active" : ""} onClick={() => setTaskSearchScope("current")}>目前</button><button type="button" className={taskSearchScope === "all" ? "active" : ""} onClick={() => setTaskSearchScope("all")}>全部</button></div><button type="button" onClick={() => { setTaskSearch(""); setTaskSearchOpen(false); }}>×</button></div>}
        {!bossAssignmentOpen && !selectedDepartment && active && pendingModelSwitch?.workerId === active.id && <ModelSwitchCard
          workerName={active.name}
          currentModelLabel={modelOptions.find((option) => option.id === (active.model ?? ""))?.label ?? active.model ?? "預設模型"}
          targetModelLabel={modelOptions.find((option) => option.id === pendingModelSwitch.model)?.label ?? (pendingModelSwitch.model || "預設模型")}
          focusMode={taskFocusMode}
          submitting={modelSwitchSubmitting}
          onContinue={() => commitModelSwitch(false)}
          onFresh={() => commitModelSwitch(true)}
          onCancel={() => setPendingModelSwitch(null)}
        />}
        {!bossAssignmentOpen && !selectedDepartment && <QuestLog key={`${activeSessionKey}:${taskSearchScope}`} readerKey={activeSessionKey} turns={taskLogTurns} view={preferences.taskLogView} searchQuery={taskSearch} focusMode={taskFocusMode} onApprove={(approvalId, decision) => {
          const owner = workerList.find((worker) => worker.turns.some((turn) => turn.items.some((item) => item.kind === "approval" && item.request.id === approvalId)));
          return owner ? resolveApproval(owner.id, approvalId, decision) : Promise.resolve("找不到需要核准的 NPC");
        }} />}
        {!bossAssignmentOpen && selectedDepartment && selectedDepartmentLead && <DepartmentMissionDialog
          embedded
          focusMode={taskFocusMode}
          missionDetailId={bossMissionDetailId}
          focusSection={departmentFocusSection}
          boss={selectedDepartmentLead}
          workers={workerList}
          missions={Object.values(missions)}
          legacyTasks={Object.values(collaborations)}
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
        placeholder={active?.busy ? `${active.name} 執勤中，可輸入或附加檔案排隊…` : `對 ${active?.name ?? "…"} 下指令（可附加圖片或文件）`}
        submitLabel="執行"
        disabled={!active || activeAuth.status !== "authenticated"}
        layout="dock"
        focusMode={taskFocusMode}
        focusRequest={composerFocusRequest}
        busy={Boolean(active?.busy)}
        queueEnabled
        persistExtras
        globalDrop={activeAuth.status === "authenticated" && !workspaceOpen && !commandCenterOpen && !avatarWorkerId && !handoffTarget && !personaWorkerId && !mcpModalOpen}
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
        onSubmit={(command) => activeId ? send(activeId, command) : Promise.resolve("沒有可用的人員")}
        onInterrupt={() => {
          if (!activeId) return;
          void interrupt(activeId).then((error) => error ? notify(error, "error") : notify("已送出中止要求", "info"));
        }}
      />}
      </div>
      </div>

      <WorkerTabs
        workers={workerList}
        activeId={activeId}
        departments={Object.values(departments)}
        missions={Object.values(missions)}
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
        onRefresh={refreshAuth}
        onInstall={installProvider}
        onUseProvider={(provider) => {
          if (active) void changeProvider(provider);
          else openWorkspaceForCreate(provider);
        }}
      />}

      {workspaceOpen && <WorkspacePicker required={workspaceSetupRequired} mode={workspaceMode} currentPath={activeWorkspace} recentPaths={workspacePaths} resetsConversation={workspaceMode === "move" && Boolean(active?.turns.length)} onBrowse={pickWorkspace} onClose={() => setWorkspaceOpen(false)} onSelect={async (path) => {
        if (workspaceMode === "create") {
          const result = await createWorker(undefined, newWorkerProvider, path);
          if (!result.error) notify("新工位建造中");
          return result.error ?? null;
        }
        if (!activeId) return "請先選擇要搬遷的 NPC";
        const error = await switchWorkspace(activeId, path);
        if (!error) notify("人員已搬到新房間");
        return error;
      }} />}

      {avatarWorkerId && workers[avatarWorkerId] && <AvatarWorkshop worker={workers[avatarWorkerId]} onSave={async (id, data, mime) => { const error = await saveAvatar(id, data, mime); if (!error) notify("自訂角色已套用"); return error; }} onPreset={async (id, presetId) => { const error = await selectAvatarPreset(id, presetId); if (!error) notify("官方角色已套用"); return error; }} onActivateCustom={async (id) => { const error = await activateCustomAvatar(id); if (!error) notify("已切回自訂角色"); return error; }} onReset={async (id) => { const error = await resetAvatar(id); if (!error) notify("已刪除自訂角色並恢復經典隊員"); return error; }} onClose={() => setAvatarWorkerId(null)} />}

      {handoffTarget && active && <ProviderHandoffDialog key={`${active.id}:${handoffTarget}`} worker={active} toProvider={handoffTarget} onPrepare={prepareHandoff} onStart={startHandoff} onDirectSwitch={switchProviderFresh} onClose={() => setHandoffTarget(null)} />}

      {personaWorkerId && workers[personaWorkerId] && <PersonaEditor worker={workers[personaWorkerId]} onSave={async (id, persona) => { const error = await setPersona(id, persona); if (!error) notify(persona ? "個性已更新，下一句話生效" : "已清除個性"); return error; }} onClose={() => setPersonaWorkerId(null)} />}

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
          notify(`「${purpose}」部門已建立，共 ${ids.length} 位 NPC`);
        }}
        onClose={() => setDepartmentCreatorOpen(false)}
      />}

      {mcpModalOpen && <McpModal capabilities={activeCapabilities} provider={activeProvider} workspacePath={activeWorkspace} mcpLoginResult={mcpLoginResult} platform={system?.platform} usedMcpTools={usedMcpTools} notify={notify} onClose={() => setMcpModalOpen(false)} />}
      {backupModalOpen && <BackupModal notify={notify} onClose={() => setBackupModalOpen(false)} />}

      <footer className="app-copyright" aria-label="版權資訊">© 2026 weiwei</footer>
      <ToastRegion toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}
