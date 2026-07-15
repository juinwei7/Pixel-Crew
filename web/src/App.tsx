import { useMemo, useState } from "react";
import { useWorkers } from "./hooks/useWorkers";
import { GameCanvas } from "./components/GameCanvas";
import { QuestLog } from "./components/QuestLog";
import { WorkerTabs } from "./components/WorkerTabs";
import { McpPanel } from "./components/McpPanel";

const MODEL_OPTIONS = [
  { value: "", label: "預設模型" },
  { value: "fable", label: "Fable（最強）" },
  { value: "opus", label: "Opus" },
  { value: "sonnet", label: "Sonnet" },
  { value: "haiku", label: "Haiku（最快）" },
];

export function App() {
  const {
    workers,
    order,
    activeId,
    setActiveId,
    targetRepoPath,
    wsReady,
    capabilities,
    createWorker,
    closeWorker,
    send,
    setModel,
    interrupt,
  } = useWorkers();

  const [draft, setDraft] = useState("");
  const [panelOpen, setPanelOpen] = useState(true);
  const [mcpOpen, setMcpOpen] = useState(false);
  const [paletteIndex, setPaletteIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const workerList = order.map((id) => workers[id]).filter(Boolean);
  const active = activeId ? workers[activeId] : undefined;

  const slashMatches = useMemo(() => {
    if (!draft.startsWith("/") || draft.includes(" ")) return [];
    const prefix = draft.slice(1).toLowerCase();
    return capabilities.slashCommands
      .filter((c) => c.toLowerCase().startsWith(prefix))
      .slice(0, 8);
  }, [draft, capabilities.slashCommands]);

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

  const mcpServers = capabilities.mcpServers;
  const mcpConnected = mcpServers.filter((s) => s.status === "connected").length;

  return (
    <div className="game-root">
      <GameCanvas workers={workerList} activeId={activeId} onSelect={setActiveId} />

      <header className="hud-header">
        <div className="hud-header__title">
          <span className="hud-header__dot" />
          PIXEL CREW
        </div>
        <div className="hud-header__repo">{targetRepoPath || "…"}</div>

        <div className="mcp-chip-wrap">
          <button
            className="mcp-chip"
            onClick={() => setMcpOpen((v) => !v)}
            title="MCP server 狀態"
          >
            MCP {capabilities.loading ? "…" : `${mcpConnected}/${mcpServers.length}`}
          </button>
          {mcpOpen && <McpPanel capabilities={capabilities} />}
        </div>

        <select
          className="hud-header__model"
          value={active?.model ?? ""}
          disabled={!active || active.busy}
          onChange={(e) => activeId && setModel(activeId, e.target.value)}
          title="切換模型（對話脈絡會保留）"
        >
          {MODEL_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
        <div className={`hud-header__conn ${wsReady ? "hud-header__conn--on" : ""}`}>
          {wsReady ? "● ONLINE" : "○ CONNECTING"}
        </div>
      </header>

      <button
        className={`panel-toggle ${panelOpen ? "panel-toggle--open" : ""}`}
        onClick={() => setPanelOpen((v) => !v)}
        title={panelOpen ? "收合日誌" : "展開日誌"}
      >
        {panelOpen ? "▶" : "◀"}
      </button>

      <aside className={`holo-panel ${panelOpen ? "" : "holo-panel--closed"}`}>
        <div className="holo-panel__title">
          任務日誌
          {active && <span className="holo-panel__worker">{active.name}</span>}
        </div>
        <QuestLog turns={active?.turns ?? []} />
      </aside>

      <WorkerTabs
        workers={workerList}
        activeId={activeId}
        onSelect={setActiveId}
        onCreate={() => createWorker()}
        onClose={closeWorker}
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
          </div>
        )}
        {draft === "/" && slashMatches.length === 0 && (
          <div className="cmd-palette">
            <div className="cmd-palette__empty">
              {capabilities.loading
                ? "正在載入可用指令…"
                : "尚未發現專案或使用者指令；CLI 內建指令會在初始化後補上。"}
            </div>
          </div>
        )}
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
          disabled={!active || active.busy}
        />
        {error && <span className="command-bar__error">{error}</span>}
        <button
          className={`command-bar__submit ${active?.busy ? "command-bar__submit--stop" : ""}`}
          type="submit"
          disabled={!active || (!active.busy && !draft.trim())}
        >
          {active?.busy ? "中止" : "執行"}
        </button>
      </form>
    </div>
  );
}
