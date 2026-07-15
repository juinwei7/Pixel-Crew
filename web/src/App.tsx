import { useMemo, useState } from "react";
import { useWorkers } from "./hooks/useWorkers";
import { GameCanvas } from "./components/GameCanvas";
import { QuestLog } from "./components/QuestLog";
import { WorkerTabs } from "./components/WorkerTabs";
import { McpPanel } from "./components/McpPanel";
import { AuthGate } from "./components/AuthGate";
import { WorkspacePicker } from "./components/WorkspacePicker";
import { CommandCenter } from "./components/CommandCenter";
import type { ProviderId } from "./types";
import { roomName } from "./workspace";

const CLAUDE_MODEL_OPTIONS = [
  { id: "", label: "預設模型" },
  { id: "fable", label: "Fable（最強）" },
  { id: "opus", label: "Opus" },
  { id: "sonnet", label: "Sonnet" },
  { id: "haiku", label: "Haiku（最快）" },
];

export function App() {
  const {
    workers,
    order,
    activeId,
    setActiveId,
    targetRepoPath,
    workspacePaths,
    wsReady,
    capabilities,
    auth,
    createWorker,
    pickWorkspace,
    switchProvider,
    switchWorkspace,
    closeWorker,
    renameWorker,
    send,
    setModel,
    interrupt,
    refreshAuth,
  } = useWorkers();

  const [draft, setDraft] = useState("");
  const [panelOpen, setPanelOpen] = useState(true);
  const [mcpOpen, setMcpOpen] = useState(false);
  const [paletteIndex, setPaletteIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [commandCenterOpen, setCommandCenterOpen] = useState(false);

  const workerList = order.map((id) => workers[id]).filter(Boolean);
  const active = activeId ? workers[activeId] : undefined;
  const activeProvider: ProviderId = active?.provider ?? "claude";
  const activeWorkspace = active?.workspacePath || targetRepoPath;
  const activeAuth = auth[activeProvider];
  const activeCapabilities = capabilities[activeProvider];
  const modelOptions = activeProvider === "codex"
    ? [{ id: "", label: "預設模型" }, ...activeCapabilities.models]
    : CLAUDE_MODEL_OPTIONS;

  const slashMatches = useMemo(() => {
    if (activeProvider !== "claude" || !draft.startsWith("/") || draft.includes(" ")) return [];
    const prefix = draft.slice(1).toLowerCase();
    return activeCapabilities.slashCommands
      .filter((c) => c.toLowerCase().startsWith(prefix))
      .slice(0, 8);
  }, [draft, activeCapabilities.slashCommands, activeProvider]);

  async function submit(text: string) {
    if (!activeId) return;
    const trimmed = text.trim();
    if (!trimmed) return;
    setDraft("");
    setPaletteIndex(0);
    const err = await send(activeId, trimmed);
    setError(err);
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (active?.busy) {
      if (activeId) interrupt(activeId);
      return;
    }
    if (slashMatches.length > 0 && draft.startsWith("/") && !draft.includes(" ")) {
      submit(`/${slashMatches[paletteIndex] ?? slashMatches[0]}`);
      return;
    }
    submit(draft);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (slashMatches.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setPaletteIndex((i) => (i + 1) % slashMatches.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setPaletteIndex((i) => (i - 1 + slashMatches.length) % slashMatches.length);
    } else if (e.key === "Tab") {
      e.preventDefault();
      setDraft(`/${slashMatches[paletteIndex] ?? slashMatches[0]} `);
    }
  }

  const mcpServers = activeCapabilities.mcpServers;
  const mcpConnected = mcpServers.filter(
    (s) => s.status === "connected" || s.status === "enabled",
  ).length;
  const authReady = activeAuth.status === "authenticated";
  const authLabel =
    activeAuth.status === "authenticated"
      ? `${activeAuth.displayName.toUpperCase()} READY`
      : activeAuth.status === "checking"
        ? `${activeAuth.displayName.toUpperCase()} CHECKING`
        : activeAuth.status === "cli_missing"
          ? `${activeAuth.displayName.toUpperCase()} MISSING`
          : `${activeAuth.displayName.toUpperCase()} LOGIN`;

  return (
    <div className="game-root">
      <GameCanvas workers={workerList} activeId={activeId} onSelect={setActiveId} />

      <header className="hud-header">
        <div className="hud-header__title">
          <span className="hud-header__dot" />
          PIXEL CREW
        </div>

        <div className="mcp-chip-wrap">
          <button
            className="mcp-chip"
            onClick={() => setMcpOpen((v) => !v)}
            title="MCP server 狀態"
          >
            MCP {activeCapabilities.loading ? "…" : `${mcpConnected}/${mcpServers.length}`}
          </button>
          {mcpOpen && <McpPanel capabilities={activeCapabilities} provider={activeProvider} />}
        </div>

        <select
          className="hud-header__model hud-header__provider"
          value={activeProvider}
          disabled={Boolean(active?.busy) || (workerList.length >= 20 && Boolean(active?.turns.length))}
          onChange={(e) => {
            const provider = e.target.value as ProviderId;
            if (provider !== activeProvider) {
              void (async () => {
                if (active && active.turns.length === 0) {
                  setError(await switchProvider(active.id, provider));
                  return;
                }
                const result = await createWorker(undefined, provider, activeWorkspace);
                setError(result.error ?? null);
              })();
            }
          }}
          title={
            active?.turns.length === 0
              ? "尚未開始對話，直接切換目前 NPC 類型"
              : workerList.length >= 20
                ? "NPC 已達 20 位上限"
                : "已有對話，切換時會建立新的 NPC"
          }
        >
          <option value="claude">Claude Code</option>
          <option value="codex">Codex</option>
        </select>

        <select
          className="hud-header__model"
          value={active?.model ?? ""}
          disabled={!active || active.busy || !authReady}
          onChange={(e) => activeId && setModel(activeId, e.target.value)}
          title="切換模型（對話脈絡會保留）"
        >
          {modelOptions.map((opt) => (
            <option key={opt.id} value={opt.id}>
              {opt.label}
            </option>
          ))}
        </select>
        <div className={`hud-header__conn ${authReady ? "hud-header__conn--on" : "hud-header__conn--warn"}`}>
          {authReady ? "●" : "○"} {authLabel}
        </div>
        <div className={`hud-header__conn ${wsReady ? "hud-header__conn--on" : ""}`}>
          {wsReady ? "● SERVER ONLINE" : "○ SERVER CONNECTING"}
        </div>
      </header>

      <button
        type="button"
        className="room-banner"
        onClick={() => setWorkspaceOpen(true)}
        title="選擇新的工作位置"
      >
        <span className="room-banner__label">CURRENT ROOM</span>
        <strong>{roomName(activeWorkspace)}</strong>
        <span className="room-banner__path">{activeWorkspace}</span>
        <span className="room-banner__change">切換 ↗</span>
      </button>

      <button
        className={`panel-toggle ${panelOpen ? "panel-toggle--open" : ""}`}
        onClick={() => setPanelOpen((v) => !v)}
        title={panelOpen ? "收合日誌" : "展開日誌"}
      >
        {panelOpen ? "▶" : "◀"}
      </button>

      <aside className={`holo-panel ${panelOpen ? "" : "holo-panel--closed"}`}>
        <div className="holo-panel__title">
          <div className="holo-panel__heading">
            <span className="holo-panel__eyebrow">WORKSTREAM</span>
            <strong>任務日誌</strong>
          </div>
          {active && (
            <span className="holo-panel__worker">
              <i />
              {active.name}
            </span>
          )}
        </div>
        <QuestLog turns={active?.turns ?? []} />
      </aside>

      <WorkerTabs
        workers={workerList}
        activeId={activeId}
        onSelect={setActiveId}
        onCreate={() => createWorker(undefined, activeProvider, activeWorkspace)}
        onClose={closeWorker}
        onRename={renameWorker}
      />

      <form className="command-bar" onSubmit={handleSubmit}>
        {slashMatches.length > 0 && (
          <div className="cmd-palette">
            {slashMatches.map((cmd, i) => (
              <button
                key={cmd}
                type="button"
                className={`cmd-palette__item ${i === paletteIndex ? "cmd-palette__item--sel" : ""}`}
                onMouseEnter={() => setPaletteIndex(i)}
                onClick={() => submit(`/${cmd}`)}
              >
                /{cmd}
              </button>
            ))}
            <button type="button" className="cmd-palette__manage" onClick={() => setCommandCenterOpen(true)}>
              管理專案指令…
            </button>
          </div>
        )}
        {draft === "/" && slashMatches.length === 0 && (
          <div className="cmd-palette">
            <div className="cmd-palette__empty">
              {activeProvider === "claude"
                ? activeCapabilities.loading
                  ? "正在載入 Claude Code 指令…"
                  : "尚未發現 Claude 專案或使用者指令。"
                : "Codex 不會載入 .claude/commands；工作流會獨立管理。"}
            </div>
            <button type="button" className="cmd-palette__manage" onClick={() => setCommandCenterOpen(true)}>
              {activeProvider === "claude" ? "建立或管理 Claude 指令…" : "查看 Codex 工作流…"}
            </button>
          </div>
        )}
        <button
          type="button"
          className="command-bar__library"
          onClick={() => setCommandCenterOpen(true)}
          title="開啟指令中心"
        >
          {activeProvider === "claude" ? "CLAUDE 指令" : "CODEX 工作流"}
        </button>
        <span className="command-bar__prompt">&gt;</span>
        <input
          className="command-bar__input"
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setPaletteIndex(0);
            setError(null);
          }}
          onKeyDown={handleKeyDown}
          placeholder={
            active?.busy
              ? `${active.name} 執勤中…（可繼續切換其他工人）`
              : `對 ${active?.name ?? "…"} 下指令，/ 看指令`
          }
          disabled={!active || active.busy || !authReady}
        />
        {error && <span className="command-bar__error">{error}</span>}
        <button
          className={`command-bar__submit ${active?.busy ? "command-bar__submit--stop" : ""}`}
          type="submit"
          disabled={!active || !authReady || (!active.busy && !draft.trim())}
        >
          {active?.busy ? "中止" : "執行"}
        </button>
      </form>

      {commandCenterOpen && activeWorkspace && (
        <CommandCenter
          workspacePath={activeWorkspace}
          provider={activeProvider}
          onClose={() => setCommandCenterOpen(false)}
        />
      )}

      <AuthGate
        auth={activeAuth}
        providers={auth}
        onRefresh={refreshAuth}
        onUseProvider={(provider) => void createWorker(undefined, provider, activeWorkspace)}
      />

      {workspaceOpen && (
        <WorkspacePicker
          currentPath={activeWorkspace}
          recentPaths={workspacePaths}
          resetsConversation={Boolean(active?.turns.length)}
          onBrowse={pickWorkspace}
          onClose={() => setWorkspaceOpen(false)}
          onSelect={async (path) => {
            if (!activeId) {
              const result = await createWorker(undefined, activeProvider, path);
              return result.error ?? null;
            }
            return switchWorkspace(activeId, path);
          }}
        />
      )}
    </div>
  );
}
