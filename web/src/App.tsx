import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useWorkers } from "./hooks/useWorkers";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import { useUiPreferences, clampTaskLogWidth } from "./uiPreferences";
import { GameCanvas } from "./components/GameCanvas";
import { QuestLog } from "./components/QuestLog";
import { WorkerTabs } from "./components/WorkerTabs";
import { TopBar } from "./components/TopBar";
import { CommandComposer } from "./components/CommandComposer";
import { ToastRegion, type Toast } from "./components/ToastRegion";
import { EnergyHud } from "./components/EnergyHud";
import { AuthGate } from "./components/AuthGate";
import { WorkspacePicker } from "./components/WorkspacePicker";
import { AvatarWorkshop } from "./components/AvatarWorkshop";
import { ProviderHandoffDialog } from "./components/ProviderHandoffDialog";
import { PersonaEditor } from "./components/PersonaEditor";
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
    workers, order, activeId, setActiveId, targetRepoPath, workspacePaths, wsReady,
    capabilitiesByWorkspace, workflowRevisions, auth, providerUsage, createWorker, pickWorkspace,
    switchWorkspace, closeWorker, renameWorker, saveAvatar, resetAvatar, selectAvatarPreset, activateCustomAvatar, prepareHandoff, startHandoff,
    send, setModel, setPersona, interrupt, resolveApproval, refreshAuth, refreshUsage,
  } = useWorkers();
  const { preferences, updatePreferences, resetPreferences } = useUiPreferences();
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [commandCenterOpen, setCommandCenterOpen] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [avatarWorkerId, setAvatarWorkerId] = useState<string | null>(null);
  const [handoffTarget, setHandoffTarget] = useState<ProviderId | null>(null);
  const [personaWorkerId, setPersonaWorkerId] = useState<string | null>(null);
  const [taskSearchOpen, setTaskSearchOpen] = useState(false);
  const [taskSearch, setTaskSearch] = useState("");
  const [toasts, setToasts] = useState<Toast[]>([]);
  const resizeCleanupRef = useRef<(() => void) | null>(null);

  const workerList = order.map((id) => workers[id]).filter(Boolean);
  const active = activeId ? workers[activeId] : undefined;
  const activeProvider: ProviderId = active?.provider ?? "claude";
  const activeWorkspace = active?.workspacePath || targetRepoPath;
  const activeAuth = auth[activeProvider];
  const activeCapabilities = capabilitiesByWorkspace[activeWorkspace]?.[activeProvider] ?? EMPTY_CAPABILITIES;
  const modelOptions = mergeModelOptions(
    activeProvider === "claude" ? CLAUDE_MODEL_OPTIONS : [],
    activeCapabilities.models,
    active?.model,
  );

  const dismissToast = useCallback((id: string) => setToasts((current) => current.filter((toast) => toast.id !== id)), []);
  const notify = useCallback((message: string, tone: Toast["tone"] = "ok") => {
    setToasts((current) => [...current.slice(-3), { id: `${Date.now()}-${Math.random()}`, message, tone }]);
  }, []);

  const approvalWorker = useMemo(() => workerList.find((worker) => worker.turns.some((turn) =>
    turn.items.some((item) => item.kind === "approval" && item.status === "pending")
  )), [workerList]);

  const shortcuts = useMemo(() => ({
    onCommandPalette: () => setCommandPaletteOpen(true),
    onToggleTaskLog: () => updatePreferences({ taskLogOpen: !preferences.taskLogOpen }),
    onApproval: () => {
      if (!approvalWorker) return;
      setActiveId(approvalWorker.id);
      updatePreferences({ taskLogOpen: true });
    },
    onEscape: () => {
      setCommandPaletteOpen(false);
      setTaskSearchOpen(false);
    },
  }), [approvalWorker, preferences.taskLogOpen, setActiveId, updatePreferences]);
  useKeyboardShortcuts(shortcuts);

  useEffect(() => {
    setTaskSearch("");
    setTaskSearchOpen(false);
    setCommandPaletteOpen(false);
  }, [activeId, activeProvider, activeWorkspace]);

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

  async function changeProvider(provider: ProviderId) {
    if (provider === activeProvider) return;
    if (!active) return;
    setHandoffTarget(provider);
  }

  return (
    <div className="game-root" style={{ "--log-panel-width": `${preferences.taskLogWidth}px` } as CSSProperties}>
      <GameCanvas workers={workerList} activeId={activeId} onSelect={setActiveId} onOpenLog={() => updatePreferences({ taskLogOpen: true })} onAvatarError={(id, message) => { setActiveId(id); notify(message, "error"); }} />

      <TopBar
        active={active}
        activeWorkspace={activeWorkspace}
        capabilities={activeCapabilities}
        auth={activeAuth}
        wsReady={wsReady}
        modelOptions={modelOptions}
        workerCount={workerList.length}
        onRoom={() => setWorkspaceOpen(true)}
        onProvider={(provider) => void changeProvider(provider)}
        onModel={(model) => {
          if (!activeId) return;
          void setModel(activeId, model).then((error) => {
            if (error) notify(error, "error");
            else notify("模型設定已更新");
          });
        }}
        onRefreshAuth={() => void refreshAuth(activeProvider)}
        onResetUi={() => { resetPreferences(); notify("介面配置已重設", "info"); }}
      />

      <EnergyHud usage={providerUsage} onRefresh={refreshUsage} />

      {!wsReady && <div className="system-banner system-banner--error" role="alert"><i />本機服務重新連線中，現有畫面會保留。</div>}

      <button className={`panel-toggle ${preferences.taskLogOpen ? "panel-toggle--open" : ""}`} onClick={() => updatePreferences({ taskLogOpen: !preferences.taskLogOpen })} title={`${preferences.taskLogOpen ? "收合" : "展開"}任務日誌（⌘/Ctrl J）`} aria-label={`${preferences.taskLogOpen ? "收合" : "展開"}任務日誌`}>
        {preferences.taskLogOpen ? "▶" : "◀"}
      </button>

      <aside className={`holo-panel ${preferences.taskLogOpen ? "" : "holo-panel--closed"}`} aria-label="任務日誌">
        <button type="button" className="holo-panel__resize" aria-label="調整任務日誌寬度" title="拖曳調整；雙擊恢復閱讀版" onPointerDown={beginPanelResize} onDoubleClick={() => updatePreferences({ taskLogWidth: 600 })} onKeyDown={(event) => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          event.preventDefault();
          updatePreferences({ taskLogWidth: preferences.taskLogWidth + (event.key === "ArrowLeft" ? 24 : -24) });
        }} />
        <div className="holo-panel__title">
          <div className="holo-panel__heading"><span className="holo-panel__eyebrow">WORKSTREAM</span><strong>任務日誌</strong></div>
          {active && <span className="holo-panel__worker"><i />{active.name}</span>}
          <div className="task-log-toolbar">
            <div className="task-log-toolbar__view" aria-label="日誌模式">
              <button type="button" className={preferences.taskLogView === "summary" ? "active" : ""} onClick={() => updatePreferences({ taskLogView: "summary" })}>摘要</button>
              <button type="button" className={preferences.taskLogView === "activity" ? "active" : ""} onClick={() => updatePreferences({ taskLogView: "activity" })}>活動</button>
            </div>
            <button type="button" className={`task-log-toolbar__search ${taskSearchOpen ? "active" : ""}`} onClick={() => setTaskSearchOpen((open) => !open)} aria-label="搜尋任務日誌" title="搜尋">
              <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="5.5" /><path d="m15 15 4.5 4.5" /></svg>
            </button>
            <select aria-label="日誌寬度" value={preferences.taskLogWidth < 510 ? "420" : preferences.taskLogWidth > 720 ? "820" : "600"} onChange={(event) => updatePreferences({ taskLogWidth: Number(event.target.value) })}>
              <option value="420">緊湊</option><option value="600">閱讀</option><option value="820">寬版</option>
            </select>
          </div>
        </div>
        {taskSearchOpen && <div className="task-log-search"><span className="task-log-search__icon"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="5.5" /><path d="m15 15 4.5 4.5" /></svg></span><input value={taskSearch} autoFocus placeholder="搜尋目前 NPC 的任務" onChange={(event) => setTaskSearch(event.target.value)} /><button type="button" onClick={() => { setTaskSearch(""); setTaskSearchOpen(false); }}>×</button></div>}
        <QuestLog key={`${activeId ?? "none"}:${activeProvider}:${activeWorkspace}`} turns={active?.turns ?? []} view={preferences.taskLogView} searchQuery={taskSearch} onApprove={activeId ? (approvalId, decision) => resolveApproval(activeId, approvalId, decision) : undefined} />
      </aside>

      <WorkerTabs
        workers={workerList}
        activeId={activeId}
        currentRoom={activeWorkspace}
        filter={preferences.crewFilter}
        collapsed={preferences.crewRailCollapsed}
        onFilter={(crewFilter) => updatePreferences({ crewFilter })}
        onCollapsed={(crewRailCollapsed) => updatePreferences({ crewRailCollapsed })}
        onSelect={setActiveId}
        onCreate={() => void createWorker(undefined, activeProvider, activeWorkspace).then((result) => result.error ? notify(result.error, "error") : notify("新工位建造中"))}
        onClose={(id) => { void closeWorker(id).then((error) => error ? notify(error, "error") : notify("人員與工位拆除中", "info")); }}
        onRename={async (id, name) => { const error = await renameWorker(id, name); if (!error) notify("人員名稱已更新"); return error; }}
        onAvatar={setAvatarWorkerId}
        onPersona={setPersonaWorkerId}
        onRoom={(id) => { setActiveId(id); setWorkspaceOpen(true); }}
      />

      <CommandComposer
        key={`${activeId ?? "none"}:${activeProvider}:${activeWorkspace}`}
        active={active}
        workers={workerList}
        workspacePath={activeWorkspace}
        capabilities={activeCapabilities}
        authReady={activeAuth.status === "authenticated"}
        paletteOpen={commandPaletteOpen}
        onPaletteOpen={setCommandPaletteOpen}
        onSubmit={(text) => activeId ? send(activeId, text) : Promise.resolve("沒有可用的人員")}
        onInterrupt={() => {
          if (!activeId) return;
          void interrupt(activeId).then((error) => error ? notify(error, "error") : notify("已送出中止要求", "info"));
        }}
        onManage={() => { setCommandPaletteOpen(false); setCommandCenterOpen(true); }}
      />

      {commandCenterOpen && activeWorkspace && <Suspense fallback={<div className="command-center command-center--loading"><div className="ui-skeleton"><i /><i /><i /></div></div>}><CommandCenter workspacePath={activeWorkspace} provider={activeProvider} workers={workerList} activeWorkerId={activeId} revisions={{ claude: workflowRevisions[`claude\0${activeWorkspace}`] ?? 0, codex: workflowRevisions[`codex\0${activeWorkspace}`] ?? 0 }} onRun={async (workerId, message) => { const runError = await send(workerId, message); if (!runError) setActiveId(workerId); return runError; }} onClose={() => setCommandCenterOpen(false)} /></Suspense>}

      <AuthGate auth={activeAuth} providers={auth} onRefresh={refreshAuth} onUseProvider={(provider) => void createWorker(undefined, provider, activeWorkspace)} />

      {workspaceOpen && <WorkspacePicker currentPath={activeWorkspace} recentPaths={workspacePaths} resetsConversation={Boolean(active?.turns.length)} onBrowse={pickWorkspace} onClose={() => setWorkspaceOpen(false)} onSelect={async (path) => {
        if (!activeId) {
          const result = await createWorker(undefined, activeProvider, path);
          if (!result.error) notify("已進入新房間");
          return result.error ?? null;
        }
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
