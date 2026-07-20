import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useWorkers } from "./hooks/useWorkers";
import { topDismissibleLayer, useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import { useUiPreferences, clampTaskLogWidth } from "./uiPreferences";
import { GameCanvas } from "./components/GameCanvas";
import { QuestLog } from "./components/QuestLog";
import { WorkerTabs } from "./components/WorkerTabs";
import { TopBar } from "./components/TopBar";
import { CommandComposer } from "./components/CommandComposer";
import { ToastRegion, type Toast } from "./components/ToastRegion";
import { EnergyHud, FocusEnergy } from "./components/EnergyHud";
import { AuthGate } from "./components/AuthGate";
import { WorkspacePicker } from "./components/WorkspacePicker";
import { AvatarWorkshop } from "./components/AvatarWorkshop";
import { ProviderHandoffDialog } from "./components/ProviderHandoffDialog";
import { PersonaEditor } from "./components/PersonaEditor";
import { diffNotifications, snapshotWorker, type WorkerSnapshot } from "./notifications";
import { latestReadableTurnKey, workerFocusStatus } from "./crew";
import type { ProviderId } from "./types";

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
  slashCommands: [], mcpServers: [], models: [], toolCount: null, loading: true,
  source: "empty" as const, updatedAt: null, error: null,
};

export function App() {
  const {
    workers, order, activeId, setActiveId, targetRepoPath, system, stats, updateInfo, workspacePaths, wsReady,
    capabilitiesByWorkspace, workflowRevisions, auth, providerUsage, providerInstalls, createWorker, pickWorkspace,
    switchWorkspace, closeWorker, renameWorker, reorderWorkers, saveAvatar, resetAvatar, selectAvatarPreset, activateCustomAvatar, prepareHandoff, startHandoff,
    send, setModel, setPersona, setAutoApproveMode, interrupt, resolveApproval, refreshAuth, refreshUsage, installProvider,
  } = useWorkers();
  const { preferences, updatePreferences, resetPreferences } = useUiPreferences();
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [workspaceMode, setWorkspaceMode] = useState<"create" | "move">("move");
  const [newWorkerProvider, setNewWorkerProvider] = useState<ProviderId>("claude");
  const [commandCenterOpen, setCommandCenterOpen] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [avatarWorkerId, setAvatarWorkerId] = useState<string | null>(null);
  const [handoffTarget, setHandoffTarget] = useState<ProviderId | null>(null);
  const [providerChanging, setProviderChanging] = useState(false);
  const [personaWorkerId, setPersonaWorkerId] = useState<string | null>(null);
  const [taskSearchOpen, setTaskSearchOpen] = useState(false);
  const [taskSearch, setTaskSearch] = useState("");
  const [taskSearchScope, setTaskSearchScope] = useState<"current" | "all">("current");
  const [taskFocusMode, setTaskFocusMode] = useState(false);
  const [focusUsageOpen, setFocusUsageOpen] = useState(false);
  const [focusSeenTurns, setFocusSeenTurns] = useState<Record<string, string | null>>({});
  const [composerFocusRequest, setComposerFocusRequest] = useState(0);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  const focusLayerRef = useRef<HTMLDivElement>(null);
  const focusExitRef = useRef<HTMLButtonElement>(null);
  const focusReturnRef = useRef<HTMLElement | null>(null);

  const workerList = order.map((id) => workers[id]).filter(Boolean);
  const active = activeId ? workers[activeId] : undefined;
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

  const approvalWorker = useMemo(() => workerList.find((worker) => worker.turns.some((turn) =>
    turn.items.some((item) => item.kind === "approval" && item.status === "pending")
  )), [workerList]);

  const enterTaskFocusMode = useCallback(() => {
    focusReturnRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setFocusSeenTurns(Object.fromEntries(workerList.map((worker) => [worker.id, latestReadableTurnKey(worker)])));
    updatePreferences({ taskLogOpen: true });
    setTaskFocusMode(true);
  }, [updatePreferences, workerList]);

  const exitTaskFocusMode = useCallback(() => {
    setFocusUsageOpen(false);
    setTaskFocusMode(false);
  }, []);

  const shortcuts = useMemo(() => ({
    onCommandPalette: () => setCommandPaletteOpen(true),
    onToggleTaskLog: () => taskFocusMode
      ? exitTaskFocusMode()
      : updatePreferences({ taskLogOpen: !preferences.taskLogOpen }),
    onApproval: () => {
      if (!approvalWorker) return;
      setActiveId(approvalWorker.id);
      updatePreferences({ taskLogOpen: true });
    },
    onEscape: () => {
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
  }), [approvalWorker, commandPaletteOpen, exitTaskFocusMode, preferences.taskLogOpen, setActiveId, taskFocusMode, taskSearchOpen, updatePreferences]);
  useKeyboardShortcuts(shortcuts);

  useEffect(() => {
    setTaskSearch("");
    setTaskSearchOpen(false);
    setFocusUsageOpen(false);
    setCommandPaletteOpen(false);
  }, [activeId, activeProvider, activeWorkspace]);

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

  return (
    <div className={`game-root ${taskFocusMode ? "game-root--focus" : ""}`} style={{ "--log-panel-width": `${preferences.taskLogWidth}px` } as CSSProperties}>
      <GameCanvas
        workers={workerList}
        activeId={activeId}
        completedTurns={stats.completedTurns}
        onSelect={activateNpc}
        onOpenLog={activateNpc}
        onAvatarError={(id, message) => { setActiveId(id); notify(message, "error"); }}
        onRename={async (id, name) => { const error = await renameWorker(id, name); if (!error) notify("人員名稱已更新"); return error; }}
        onAvatarWorkshop={setAvatarWorkerId}
        onPersonaEditor={setPersonaWorkerId}
        onRoomSwitch={(id) => { setActiveId(id); openWorkspaceForMove(); }}
        onRemove={(id) => { void closeWorker(id).then((error) => error ? notify(error, "error") : notify("人員與工位拆除中", "info")); }}
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
        onProvider={(provider) => void changeProvider(provider)}
        onModel={(model) => {
          if (!activeId) return;
          void setModel(activeId, model).then((error) => {
            if (error) notify(error, "error");
            else notify("模型設定已更新");
          });
        }}
        onAutoApprove={(mode) => {
          if (!activeId) return;
          void setAutoApproveMode(activeId, mode).then((error) => {
            if (error) { notify(error, "error"); return; }
            if (mode === "off") notify("自動核准已關閉");
            else if (mode === "safe") notify("安全自動核准已開啟；只有唯讀與驗證安全的指令會跳過詢問");
            else notify("完全自動核准已開啟；rm -rf、sudo 等高風險指令仍會詢問");
          });
        }}
        onRefreshAuth={() => void refreshAuth(activeProvider)}
        onResetUi={() => { resetPreferences(); notify("介面配置已重設", "info"); }}
        notificationsEnabled={preferences.notificationsEnabled}
        onNotificationsToggle={toggleNotifications}
        updateInfo={updateInfo}
      />

      {!taskFocusMode && <EnergyHud usage={providerUsage} onRefresh={refreshUsage} />}

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
          <div className="holo-panel__heading"><span className="holo-panel__eyebrow">{taskFocusMode ? "FOCUS READER" : "WORKSTREAM"}</span><strong>{taskFocusMode ? "專心閱讀" : "任務日誌"}</strong></div>
          {taskFocusMode ? <label className="focus-worker-switch">
            <span>NPC</span>
            <select aria-label="切換專心模式的 NPC 工作介面" value={activeId ?? ""} onChange={(event) => activateNpc(event.target.value)}>
              {!activeId && <option value="" disabled>選擇 NPC</option>}
              {workerList.map((worker) => {
                const latestKey = latestReadableTurnKey(worker);
                const unread = worker.id !== activeId && Boolean(latestKey) && latestKey !== focusSeenTurns[worker.id];
                return <option key={worker.id} value={worker.id}>{unread ? "● " : ""}{worker.name} · {worker.provider === "claude" ? "Claude" : "Codex"} · {workerFocusStatus(worker)}</option>;
              })}
            </select>
          </label> : active && <span className="holo-panel__worker"><i />{active.name}</span>}
          {taskFocusMode && <FocusEnergy usage={providerUsage} onRefresh={refreshUsage} activeProvider={activeProvider} open={focusUsageOpen} onOpenChange={setFocusUsageOpen} />}
          <div className="task-log-toolbar">
            {!taskFocusMode && <div className="task-log-toolbar__view" aria-label="日誌模式">
              <button type="button" className={preferences.taskLogView === "summary" ? "active" : ""} onClick={() => updatePreferences({ taskLogView: "summary" })}>摘要</button>
              <button type="button" className={preferences.taskLogView === "activity" ? "active" : ""} onClick={() => updatePreferences({ taskLogView: "activity" })}>活動</button>
            </div>}
            <button type="button" className={`task-log-toolbar__search ${taskSearchOpen ? "active" : ""}`} onClick={() => setTaskSearchOpen((open) => !open)} aria-label="搜尋任務日誌" title="搜尋">
              <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="5.5" /><path d="m15 15 4.5 4.5" /></svg>
            </button>
            {!taskFocusMode && <button type="button" className="task-log-toolbar__focus" onClick={enterTaskFocusMode} aria-label="進入專心閱讀模式" title="專心閱讀"><span aria-hidden="true">▣</span> 專心</button>}
            {!taskFocusMode && <select aria-label="日誌寬度" value={preferences.taskLogWidth < 510 ? "420" : preferences.taskLogWidth > 720 ? "820" : "600"} onChange={(event) => updatePreferences({ taskLogWidth: Number(event.target.value) })}>
              <option value="420">緊湊</option><option value="600">閱讀</option><option value="820">寬版</option>
            </select>}
            {taskFocusMode && <button ref={focusExitRef} type="button" className="task-log-toolbar__exit" onClick={exitTaskFocusMode} aria-label="退出專心閱讀模式">退出 <kbd>Esc</kbd></button>}
          </div>
        </div>
        {taskSearchOpen && <div className="task-log-search"><span className="task-log-search__icon"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="5.5" /><path d="m15 15 4.5 4.5" /></svg></span><input value={taskSearch} autoFocus placeholder={taskSearchScope === "current" ? "搜尋目前 NPC 的任務" : "搜尋全部 NPC 的任務"} onChange={(event) => setTaskSearch(event.target.value)} /><div className="task-log-search__scope" aria-label="搜尋範圍"><button type="button" className={taskSearchScope === "current" ? "active" : ""} onClick={() => setTaskSearchScope("current")}>目前</button><button type="button" className={taskSearchScope === "all" ? "active" : ""} onClick={() => setTaskSearchScope("all")}>全部</button></div><button type="button" onClick={() => { setTaskSearch(""); setTaskSearchOpen(false); }}>×</button></div>}
        <QuestLog key={`${activeSessionKey}:${taskSearchScope}`} readerKey={activeSessionKey} turns={taskLogTurns} view={preferences.taskLogView} searchQuery={taskSearch} focusMode={taskFocusMode} onApprove={(approvalId, decision) => {
          const owner = workerList.find((worker) => worker.turns.some((turn) => turn.items.some((item) => item.kind === "approval" && item.request.id === approvalId)));
          return owner ? resolveApproval(owner.id, approvalId, decision) : Promise.resolve("找不到需要核准的 NPC");
        }} />
      </aside>

      <CommandComposer
        active={active}
        workers={workerList}
        workspacePath={activeWorkspace}
        capabilities={activeCapabilities}
        authReady={activeAuth.status === "authenticated"}
        focusMode={taskFocusMode}
        sessionKey={activeSessionKey}
        globalDropEnabled={activeAuth.status === "authenticated" && !workspaceOpen && !commandCenterOpen && !avatarWorkerId && !handoffTarget && !personaWorkerId}
        paletteOpen={commandPaletteOpen}
        focusRequest={composerFocusRequest}
        onPaletteOpen={setCommandPaletteOpen}
        onSubmit={(command) => activeId ? send(activeId, command) : Promise.resolve("沒有可用的人員")}
        onInterrupt={() => {
          if (!activeId) return;
          void interrupt(activeId).then((error) => error ? notify(error, "error") : notify("已送出中止要求", "info"));
        }}
        onManage={() => { exitTaskFocusMode(); setCommandPaletteOpen(false); setCommandCenterOpen(true); }}
      />
      </div>

      <WorkerTabs
        workers={workerList}
        activeId={activeId}
        currentRoom={activeWorkspace}
        filter={preferences.crewFilter}
        collapsed={preferences.crewRailCollapsed}
        onFilter={(crewFilter) => updatePreferences({ crewFilter })}
        onCollapsed={(crewRailCollapsed) => updatePreferences({ crewRailCollapsed })}
        onSelect={setActiveId}
        onReorder={(ids) => { void reorderWorkers(ids).then((error) => { if (error) notify(error, "error"); }); }}
        onCreate={() => openWorkspaceForCreate(activeProvider)}
        onClose={(id) => { void closeWorker(id).then((error) => error ? notify(error, "error") : notify("人員與工位拆除中", "info")); }}
        onRename={async (id, name) => { const error = await renameWorker(id, name); if (!error) notify("人員名稱已更新"); return error; }}
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

      {handoffTarget && active && <ProviderHandoffDialog key={`${active.id}:${handoffTarget}`} worker={active} toProvider={handoffTarget} onPrepare={prepareHandoff} onStart={startHandoff} onClose={() => setHandoffTarget(null)} />}

      {personaWorkerId && workers[personaWorkerId] && <PersonaEditor worker={workers[personaWorkerId]} onSave={async (id, persona) => { const error = await setPersona(id, persona); if (!error) notify(persona ? "個性已更新，下一句話生效" : "已清除個性"); return error; }} onClose={() => setPersonaWorkerId(null)} />}

      <footer className="app-copyright" aria-label="版權資訊">© 2026 weiwei</footer>
      <ToastRegion toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}
