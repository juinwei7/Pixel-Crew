import { useEffect, useMemo, useRef, useState } from "react";
import type { CapabilityState, ProviderId, WorkerState } from "../types";
import { apiRequest } from "../api";
import { deriveCommandHistory } from "../commandHistory";
import { composerEnterAction, mergePaletteNames } from "../commandInteraction";

type PaletteItem = { key: string; label: string; description: string; value: string; kind: "recent" | "project" };
type LibraryEntry = { name: string; description: string; argumentHint?: string };

type Props = {
  active?: WorkerState;
  workers: WorkerState[];
  workspacePath: string;
  capabilities: CapabilityState;
  authReady: boolean;
  paletteOpen: boolean;
  onPaletteOpen(open: boolean): void;
  onSubmit(text: string): Promise<string | null>;
  onInterrupt(): void;
  onManage(): void;
};

export function CommandComposer({ active, workers, workspacePath, capabilities, authReady, paletteOpen, onPaletteOpen, onSubmit, onInterrupt, onManage }: Props) {
  const [draft, setDraft] = useState("");
  const [selected, setSelected] = useState(0);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [error, setError] = useState<string | null>(null);
  const [library, setLibrary] = useState<LibraryEntry[]>([]);
  const [libraryLoading, setLibraryLoading] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // True while an IME (e.g. 注音/拼音) is mid-composition, so Enter confirms a
  // candidate instead of submitting a half-typed message.
  const composingRef = useRef(false);
  const provider = active?.provider ?? "claude";
  const history = useMemo(() => deriveCommandHistory(workers, provider, workspacePath), [workers, provider, workspacePath]);
  const query = draft.startsWith("/") || draft.startsWith("$") ? draft.slice(1).toLowerCase() : draft.toLowerCase();
  const items = useMemo<PaletteItem[]>(() => {
    // Project commands (with metadata) merged with the provider's full
    // slash-command set, so a room that has disk commands doesn't hide the
    // built-in /clear, /compact, … once the palette fetch completes. Codex
    // has no built-in slash set here, so it stays library (skills) only.
    const names: LibraryEntry[] = provider === "claude"
      ? mergePaletteNames(library, capabilities.slashCommands)
      : library;
    const project = names.map((entry) => ({
      key: `project-${entry.name}`,
      label: `${provider === "claude" ? "/" : "$"}${entry.name}`,
      description: entry.description || (provider === "claude" ? "Claude 專案指令" : "Codex Repo Skill"),
      value: `${provider === "claude" ? "/" : "$"}${entry.name}${entry.argumentHint ? ` ${entry.argumentHint}` : " "}`,
      kind: "project" as const,
    }));
    const recent = history.map((command, index) => ({
      key: `recent-${index}-${command}`,
      label: command,
      description: `最近使用 · ${provider === "claude" ? "Claude" : "Codex"}`,
      value: command,
      kind: "recent" as const,
    }));
    return [...project, ...recent].filter((item) => !query || item.label.toLowerCase().includes(query)).slice(0, 12);
  }, [provider, capabilities.slashCommands, history, query, library]);

  useEffect(() => {
    if (!paletteOpen) return;
    let cancelled = false;
    setLibraryLoading(true);
    const endpoint = provider === "claude" ? "/api/commands" : "/api/skills";
    apiRequest<{ commands?: LibraryEntry[]; skills?: LibraryEntry[] }>(`${endpoint}?workspacePath=${encodeURIComponent(workspacePath)}`)
      .then((data) => {
        if (!cancelled) setLibrary(data.commands ?? data.skills ?? []);
      })
      .catch(() => !cancelled && setLibrary([]))
      .finally(() => !cancelled && setLibraryLoading(false));
    return () => { cancelled = true; };
  }, [paletteOpen, provider, workspacePath]);

  useEffect(() => {
    if (paletteOpen) {
      setSelected(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [paletteOpen]);

  useEffect(() => {
    if (!paletteOpen) return;
    const closeOutside = (event: PointerEvent) => {
      if (!formRef.current?.contains(event.target as Node)) onPaletteOpen(false);
    };
    window.addEventListener("pointerdown", closeOutside);
    return () => window.removeEventListener("pointerdown", closeOutside);
  }, [paletteOpen, onPaletteOpen]);

  // Grow the field to fit its content (Shift+Enter newlines) up to a cap,
  // then let it scroll. Runs for typed and programmatic (history/choose) edits.
  useEffect(() => {
    const field = inputRef.current;
    if (!field) return;
    field.style.height = "auto";
    field.style.height = `${Math.min(field.scrollHeight, 160)}px`;
  }, [draft]);

  function choose(item: PaletteItem) {
    setDraft(item.value);
    setHistoryIndex(-1);
    setError(null);
    onPaletteOpen(false);
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  async function submit() {
    if (!active) return;
    if (active.busy) {
      onInterrupt();
      return;
    }
    if (paletteOpen) return;
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    onPaletteOpen(false);
    const message = await onSubmit(text);
    setError(message);
    if (message) setDraft(text);
  }

  return (
    <form ref={formRef} className="command-composer" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      {paletteOpen && (
        <div className="command-palette" role="listbox" aria-label={`${provider} 指令面板`}>
          <div className="command-palette__head"><span>{provider === "claude" ? "CLAUDE COMMANDS" : "CODEX WORKFLOWS"}</span><kbd>Esc</kbd></div>
          <div className="command-palette__items">
            {libraryLoading && <div className="command-palette__skeleton"><i /><i /><i /></div>}
            {!libraryLoading && items.map((item, index) => (
              <button key={item.key} type="button" role="option" aria-selected={index === selected} className={index === selected ? "command-palette__item--active" : ""} onMouseEnter={() => setSelected(index)} onClick={() => choose(item)}>
                <strong>{item.label}</strong><small>{item.description}</small><span>{item.kind === "recent" ? "↺" : "↵"}</span>
              </button>
            ))}
            {!libraryLoading && items.length === 0 && <div className="command-palette__empty">找不到相符指令</div>}
          </div>
          <button className="command-palette__manage" type="button" onClick={onManage}>管理 {provider === "claude" ? "Claude 指令" : "Codex 工作流"}…</button>
        </div>
      )}
      <button className="command-composer__library" type="button" onClick={() => onPaletteOpen(!paletteOpen)} aria-expanded={paletteOpen} title="指令面板（⌘/Ctrl K）">
        ⌘ <span>{provider === "claude" ? "CLAUDE" : "CODEX"}</span>
      </button>
      <span className="command-composer__prompt">›</span>
      <textarea
        ref={inputRef}
        value={draft}
        rows={1}
        spellCheck={false}
        disabled={!active || active.busy || !authReady}
        placeholder={active?.busy ? `${active.name} 執勤中…` : `對 ${active?.name ?? "…"} 下指令（Shift+Enter 換行）`}
        aria-label="輸入 Agent 指令"
        onCompositionStart={() => { composingRef.current = true; }}
        onCompositionEnd={() => { composingRef.current = false; }}
        onChange={(event) => {
          const value = event.target.value;
          setDraft(value);
          setError(null);
          setHistoryIndex(-1);
          if (value === "/" || (value.startsWith("/") && !value.includes(" "))) onPaletteOpen(true);
        }}
        onKeyDown={(event) => {
          // While composing (IME), defer Enter / arrows / Tab to the input
          // method so it can confirm or navigate candidates.
          if (composingRef.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
          if (event.key === "Escape") {
            onPaletteOpen(false);
            return;
          }
          if (paletteOpen && items.length > 0) {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              setSelected((index) => event.key === "ArrowDown" ? (index + 1) % items.length : (index - 1 + items.length) % items.length);
              return;
            }
            if (event.key === "Tab") {
              event.preventDefault();
              choose(items[selected] ?? items[0]);
              return;
            }
          }
          // Only steer history while the draft is a single line, so once the
          // user has added a newline the arrows move the caret as usual.
          if (!paletteOpen && (event.key === "ArrowUp" || event.key === "ArrowDown") && history.length > 0 && !draft.includes("\n")) {
            event.preventDefault();
            const next = event.key === "ArrowUp" ? Math.min(history.length - 1, historyIndex + 1) : Math.max(-1, historyIndex - 1);
            setHistoryIndex(next);
            setDraft(next < 0 ? "" : history[next]);
          }
          if (event.key === "Enter") {
            const action = composerEnterAction(paletteOpen, libraryLoading, items.length, event.shiftKey);
            if (action === "ignore" && event.shiftKey) return; // Shift+Enter inserts a newline
            // A textarea never submits the form on Enter, so drive it here.
            event.preventDefault();
            if (action === "choose") choose(items[selected] ?? items[0]);
            else if (action === "submit") void submit();
          }
        }}
      />
      {error && <span className="command-composer__error" role="alert">{error}</span>}
      <button className={`command-composer__submit ${active?.busy ? "command-composer__submit--stop" : ""}`} type="submit" disabled={!active || !authReady || (!active.busy && !draft.trim())}>
        {active?.busy ? "中止" : "執行"}
      </button>
    </form>
  );
}
