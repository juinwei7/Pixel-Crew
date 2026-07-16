import { useEffect, useMemo, useRef, useState } from "react";
import type { CapabilityState, CommandSubmission, MessageImagePayload, ProviderId, WorkerState } from "../types";
import { apiRequest } from "../api";
import { deriveCommandHistory } from "../commandHistory";
import { composerEnterAction, mergePaletteNames } from "../commandInteraction";

type PaletteItem = { key: string; label: string; description: string; value: string; kind: "recent" | "project" };
type LibraryEntry = { name: string; description: string; argumentHint?: string };
type ComposerImage = MessageImagePayload & { id: string; previewUrl: string; size: number };
type QueuedCommand = { text: string; images: ComposerImage[] };

const MAX_IMAGES = 4;
const MAX_QUEUED_COMMANDS = 10;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 10 * 1024 * 1024;
const SUPPORTED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

type Props = {
  active?: WorkerState;
  workers: WorkerState[];
  workspacePath: string;
  capabilities: CapabilityState;
  authReady: boolean;
  paletteOpen: boolean;
  focusRequest?: number;
  onPaletteOpen(open: boolean): void;
  onSubmit(command: CommandSubmission): Promise<string | null>;
  onInterrupt(): void;
  onManage(): void;
};

export function CommandComposer({ active, workers, workspacePath, capabilities, authReady, paletteOpen, focusRequest = 0, onPaletteOpen, onSubmit, onInterrupt, onManage }: Props) {
  const [draft, setDraft] = useState("");
  const [selected, setSelected] = useState(0);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [error, setError] = useState<string | null>(null);
  const [images, setImages] = useState<ComposerImage[]>([]);
  const [queued, setQueued] = useState<QueuedCommand[]>([]);
  const [library, setLibrary] = useState<LibraryEntry[]>([]);
  const [libraryLoading, setLibraryLoading] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const wasBusyRef = useRef(Boolean(active?.busy));
  const dispatchingQueuedRef = useRef(false);
  const onSubmitRef = useRef(onSubmit);
  onSubmitRef.current = onSubmit;
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
    if (focusRequest <= 0 || !active || !authReady) return;
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [focusRequest, active?.id, authReady]);

  // Keep the composer ready for a follow-up message and automatically send
  // the next queued command once the worker returns to idle.
  useEffect(() => {
    const busy = Boolean(active?.busy);
    if (wasBusyRef.current && !busy && authReady) {
      requestAnimationFrame(() => inputRef.current?.focus());
    }
    wasBusyRef.current = busy;
  }, [active?.busy, authReady]);

  useEffect(() => {
    if (active?.busy || !authReady || queued.length === 0 || dispatchingQueuedRef.current) return;
    const next = queued[0];
    dispatchingQueuedRef.current = true;
    setQueued((commands) => commands.slice(1));
    void onSubmitRef.current({ text: next.text, images: next.images.map(imagePayload) })
      .then((message) => {
        if (message) {
          setError(message);
          setDraft((current) => current || next.text);
          setImages((current) => current.length ? current : next.images);
        }
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : "排隊訊息送出失敗");
        setDraft((current) => current || next.text);
        setImages((current) => current.length ? current : next.images);
      })
      .finally(() => { dispatchingQueuedRef.current = false; });
  }, [active?.busy, authReady, queued]);

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
    if (paletteOpen) return;
    const text = draft.trim();
    const command = { text, images };
    if (active.busy || dispatchingQueuedRef.current) {
      if (!text && images.length === 0) {
        onInterrupt();
        return;
      }
      if (queued.length >= MAX_QUEUED_COMMANDS) {
        setError(`等待佇列最多 ${MAX_QUEUED_COMMANDS} 項`);
        return;
      }
      setDraft("");
      setImages([]);
      setError(null);
      setQueued((commands) => [...commands, command]);
      requestAnimationFrame(() => inputRef.current?.focus());
      return;
    }
    if (!text && images.length === 0) return;
    setDraft("");
    setImages([]);
    onPaletteOpen(false);
    requestAnimationFrame(() => inputRef.current?.focus());
    const message = await onSubmit({ text, images: images.map(imagePayload) });
    setError(message);
    if (message) {
      setDraft((current) => current || text);
      setImages((current) => current.length ? current : images);
    }
  }

  async function attachPastedImages(files: File[]) {
    const candidates = files.filter((file) => file.type.startsWith("image/"));
    if (candidates.length === 0) return;
    const slots = MAX_IMAGES - images.length;
    if (slots <= 0 || candidates.length > slots) {
      setError(`每則訊息最多 ${MAX_IMAGES} 張圖片`);
      return;
    }
    if (candidates.some((file) => !SUPPORTED_IMAGE_TYPES.has(file.type))) {
      setError("只支援 PNG、JPEG 與 WebP 圖片");
      return;
    }
    if (candidates.some((file) => file.size > MAX_IMAGE_BYTES)) {
      setError("每張圖片不可超過 5 MiB");
      return;
    }
    if (images.reduce((sum, image) => sum + image.size, 0) + candidates.reduce((sum, file) => sum + file.size, 0) > MAX_TOTAL_IMAGE_BYTES) {
      setError("圖片總大小不可超過 10 MiB");
      return;
    }
    try {
      const added = await Promise.all(candidates.map(readComposerImage));
      setImages((current) => [...current, ...added]);
      setError(null);
      requestAnimationFrame(() => inputRef.current?.focus());
    } catch {
      setError("無法讀取剪貼簿圖片");
    }
  }

  const hasContent = Boolean(draft.trim() || images.length);

  return (
    <form ref={formRef} className={`command-composer ${images.length ? "command-composer--attachments" : ""}`} onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      {images.length > 0 && <div className="command-composer__attachments" aria-label="待傳送圖片">
        {images.map((image, index) => <div className="command-composer__attachment" key={image.id}>
          <img src={image.previewUrl} alt={`圖片 ${index + 1}：${image.name}`} />
          <span>IMG {index + 1}</span>
          <button type="button" aria-label={`移除圖片 ${index + 1}`} onClick={() => setImages((current) => current.filter((item) => item.id !== image.id))}>×</button>
        </div>)}
      </div>}
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
        autoFocus={focusRequest > 0}
        value={draft}
        rows={1}
        spellCheck={false}
        disabled={!active || !authReady}
        aria-busy={Boolean(active?.busy)}
        placeholder={active?.busy ? `${active.name} 執勤中，可輸入或貼圖排隊…` : `對 ${active?.name ?? "…"} 下指令（可貼上圖片）`}
        aria-label="輸入 Agent 指令"
        onPaste={(event) => {
          const files = Array.from(event.clipboardData.items).map((item) => item.kind === "file" ? item.getAsFile() : null).filter((file): file is File => Boolean(file));
          if (files.some((file) => file.type.startsWith("image/"))) {
            event.preventDefault();
            void attachPastedImages(files);
          }
        }}
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
      {queued.length > 0 && <span className="command-composer__queue" role="status">等待 {queued.length}</span>}
      <button className={`command-composer__submit ${active?.busy && !hasContent ? "command-composer__submit--stop" : ""}`} type="submit" disabled={!active || !authReady || (!active.busy && !hasContent)}>
        {active?.busy ? (hasContent ? "排隊" : "中止") : "執行"}
      </button>
    </form>
  );
}

function imagePayload(image: ComposerImage): MessageImagePayload {
  return { name: image.name, mimeType: image.mimeType, dataBase64: image.dataBase64 };
}

async function readComposerImage(file: File): Promise<ComposerImage> {
  const previewUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("invalid image"));
    reader.onerror = () => reject(reader.error ?? new Error("image read failed"));
    reader.readAsDataURL(file);
  });
  const dataBase64 = previewUrl.slice(previewUrl.indexOf(",") + 1);
  return {
    id: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`,
    name: file.name || `clipboard-${Date.now()}`,
    mimeType: file.type as ComposerImage["mimeType"],
    dataBase64,
    previewUrl,
    size: file.size,
  };
}
