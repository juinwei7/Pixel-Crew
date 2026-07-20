import { useEffect, useMemo, useRef, useState } from "react";
import type { CapabilityState, CommandSubmission, MessageDocumentPayload, MessageImagePayload, ProviderId, WorkerState } from "../types";
import { apiRequest } from "../api";
import { deriveCommandHistory } from "../commandHistory";
import { buildProviderWorkflowEntries, composerEnterAction } from "../commandInteraction";

type PaletteItem = { key: string; label: string; description: string; value: string; kind: "recent" | "project" };
type LibraryEntry = { name: string; description: string; argumentHint?: string };
type ComposerImage = MessageImagePayload & { id: string; previewUrl: string; size: number };
type ComposerDocument = MessageDocumentPayload & { id: string; size: number };
type QueuedCommand = { text: string; images: ComposerImage[]; documents: ComposerDocument[] };
type ComposerSession = { draft: string; images: ComposerImage[]; documents: ComposerDocument[]; queued: QueuedCommand[]; error: string | null };

const MAX_IMAGES = 4;
const MAX_DOCUMENTS = 4;
const MAX_QUEUED_COMMANDS = 10;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 10 * 1024 * 1024;
const SUPPORTED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_DOCUMENT_BYTES = 20 * 1024 * 1024;
const SUPPORTED_DOCUMENT_EXTENSIONS = new Set(["txt", "md", "csv", "json", "html", "htm", "xml", "yaml", "yml", "log", "pdf", "docx", "xlsx", "pptx"]);
const FILE_ACCEPT = "image/png,image/jpeg,image/webp,.txt,.md,.csv,.json,.html,.htm,.xml,.yaml,.yml,.log,.pdf,.docx,.xlsx,.pptx";

type Props = {
  active?: WorkerState;
  workers: WorkerState[];
  workspacePath: string;
  capabilities: CapabilityState;
  authReady: boolean;
  focusMode?: boolean;
  sessionKey?: string;
  paletteOpen: boolean;
  focusRequest?: number;
  onPaletteOpen(open: boolean): void;
  onSubmit(command: CommandSubmission): Promise<string | null>;
  onInterrupt(): void;
  onManage(): void;
};

export function CommandComposer({ active, workers, workspacePath, capabilities, authReady, focusMode = false, sessionKey = "default", paletteOpen, focusRequest = 0, onPaletteOpen, onSubmit, onInterrupt, onManage }: Props) {
  const [draft, setDraft] = useState("");
  const [selected, setSelected] = useState(0);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [error, setError] = useState<string | null>(null);
  const [images, setImages] = useState<ComposerImage[]>([]);
  const [documents, setDocuments] = useState<ComposerDocument[]>([]);
  const [queued, setQueued] = useState<QueuedCommand[]>([]);
  const [library, setLibrary] = useState<LibraryEntry[]>([]);
  const [libraryLoading, setLibraryLoading] = useState(false);
  const [dispatchTick, setDispatchTick] = useState(0);
  const formRef = useRef<HTMLFormElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const wasBusyRef = useRef(Boolean(active?.busy));
  const dispatchingSessionsRef = useRef(new Set<string>());
  const sessionCacheRef = useRef(new Map<string, ComposerSession>());
  const sessionOwnerRef = useRef(sessionKey);
  const onSubmitRef = useRef(onSubmit);
  onSubmitRef.current = onSubmit;
  // True while an IME (e.g. 注音/拼音) is mid-composition, so Enter confirms a
  // candidate instead of submitting a half-typed message.
  const composingRef = useRef(false);
  const provider = active?.provider ?? "claude";
  const switchingSession = sessionOwnerRef.current !== sessionKey;
  const history = useMemo(() => deriveCommandHistory(workers, provider, workspacePath), [workers, provider, workspacePath]);
  const query = draft.startsWith("/") || draft.startsWith("$") ? draft.slice(1).toLowerCase() : draft.toLowerCase();
  const items = useMemo<PaletteItem[]>(() => {
    const invocation = draft.startsWith("/") ? "/" : draft.startsWith("$") ? "$" : null;
    const project = buildProviderWorkflowEntries(provider, library, capabilities.slashCommands).map((entry) => ({
      key: `project-${entry.key}`,
      label: entry.label,
      description: entry.description || (provider === "claude" ? "Claude 專案指令" : "Codex Repo Skill"),
      value: entry.value,
      kind: "project" as const,
    })).filter((entry) => !invocation || entry.label.startsWith(invocation));
    const recent = history.map((command, index) => ({
      key: `recent-${index}-${command}`,
      label: command,
      description: `最近使用 · ${provider === "claude" ? "Claude" : "Codex"}`,
      value: command,
      kind: "recent" as const,
    }));
    return [...project, ...recent].filter((item) => {
      if (invocation && item.kind === "recent" && !item.label.startsWith(invocation)) return false;
      return !query || item.label.toLowerCase().includes(query);
    }).slice(0, 12);
  }, [provider, capabilities.slashCommands, history, query, library]);

  function updateCachedSession(owner: string, update: (session: ComposerSession) => ComposerSession) {
    const current = sessionCacheRef.current.get(owner) ?? { draft: "", images: [], documents: [], queued: [], error: null };
    sessionCacheRef.current.set(owner, update(current));
  }

  useEffect(() => {
    if (!switchingSession) return;
    sessionCacheRef.current.set(sessionOwnerRef.current, { draft, images, documents, queued, error });
    const next = sessionCacheRef.current.get(sessionKey) ?? { draft: "", images: [], documents: [], queued: [], error: null };
    sessionOwnerRef.current = sessionKey;
    setDraft(next.draft);
    setImages(next.images);
    setDocuments(next.documents);
    setQueued(next.queued);
    setError(next.error);
    setSelected(0);
    setHistoryIndex(-1);
    onPaletteOpen(false);
  }, [sessionKey, switchingSession]);

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
    if (switchingSession || active?.busy || !authReady || queued.length === 0 || dispatchingSessionsRef.current.has(sessionKey)) return;
    const next = queued[0];
    const owner = sessionOwnerRef.current;
    dispatchingSessionsRef.current.add(owner);
    setQueued((commands) => commands.slice(1));
    void onSubmitRef.current({ text: next.text, images: next.images.map(imagePayload), documents: next.documents.map(documentPayload) })
      .then((message) => {
        if (sessionOwnerRef.current !== owner) {
          updateCachedSession(owner, (session) => message ? {
            ...session,
            error: message,
            draft: session.draft || next.text,
            images: session.images.length ? session.images : next.images,
            documents: session.documents.length ? session.documents : next.documents,
          } : { ...session, error: null });
          return;
        }
        if (message) {
          setError(message);
          setDraft((current) => current || next.text);
          setImages((current) => current.length ? current : next.images);
          setDocuments((current) => current.length ? current : next.documents);
        }
      })
      .catch((cause: unknown) => {
        const message = cause instanceof Error ? cause.message : "排隊訊息送出失敗";
        if (sessionOwnerRef.current !== owner) {
          updateCachedSession(owner, (session) => ({
            ...session,
            error: message,
            draft: session.draft || next.text,
            images: session.images.length ? session.images : next.images,
            documents: session.documents.length ? session.documents : next.documents,
          }));
          return;
        }
        setError(message);
        setDraft((current) => current || next.text);
        setImages((current) => current.length ? current : next.images);
        setDocuments((current) => current.length ? current : next.documents);
      })
      .finally(() => {
        dispatchingSessionsRef.current.delete(owner);
        setDispatchTick((tick) => tick + 1);
      });
  }, [active?.busy, authReady, queued, sessionKey, switchingSession, dispatchTick]);

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
    if (!active || switchingSession) return;
    if (paletteOpen) return;
    const text = draft.trim();
    const command = { text, images, documents };
    const owner = sessionOwnerRef.current;
    if (active.busy || dispatchingSessionsRef.current.has(owner)) {
      if (!text && images.length === 0 && documents.length === 0) {
        onInterrupt();
        return;
      }
      if (queued.length >= MAX_QUEUED_COMMANDS) {
        setError(`等待佇列最多 ${MAX_QUEUED_COMMANDS} 項`);
        return;
      }
      setDraft("");
      setImages([]);
      setDocuments([]);
      setError(null);
      setQueued((commands) => [...commands, command]);
      requestAnimationFrame(() => inputRef.current?.focus());
      return;
    }
    if (!text && images.length === 0 && documents.length === 0) return;
    setDraft("");
    setImages([]);
    setDocuments([]);
    onPaletteOpen(false);
    requestAnimationFrame(() => inputRef.current?.focus());
    const message = await onSubmit({ text, images: images.map(imagePayload), documents: documents.map(documentPayload) });
    if (sessionOwnerRef.current !== owner) {
      updateCachedSession(owner, (session) => message ? {
        ...session,
        error: message,
        draft: session.draft || text,
        images: session.images.length ? session.images : images,
        documents: session.documents.length ? session.documents : documents,
      } : { ...session, error: null });
      return;
    }
    setError(message);
    if (message) {
      setDraft((current) => current || text);
      setImages((current) => current.length ? current : images);
      setDocuments((current) => current.length ? current : documents);
    }
  }

  async function attachFiles(files: File[]) {
    const owner = sessionOwnerRef.current;
    const imageFiles = files.filter(isImageFile);
    const documentFiles = files.filter((file) => !isImageFile(file));
    if (imageFiles.length > MAX_IMAGES - images.length) {
      setError(`每則訊息最多 ${MAX_IMAGES} 張圖片`);
      return;
    }
    if (documentFiles.length > MAX_DOCUMENTS - documents.length) {
      setError(`每則訊息最多 ${MAX_DOCUMENTS} 份文件`);
      return;
    }
    if (imageFiles.some((file) => !SUPPORTED_IMAGE_TYPES.has(file.type || imageMimeType(file.name)))) {
      setError("只支援 PNG、JPEG 與 WebP 圖片");
      return;
    }
    if (imageFiles.some((file) => file.size > MAX_IMAGE_BYTES)) {
      setError("每張圖片不可超過 5 MiB");
      return;
    }
    if (images.reduce((sum, image) => sum + image.size, 0) + imageFiles.reduce((sum, file) => sum + file.size, 0) > MAX_TOTAL_IMAGE_BYTES) {
      setError("圖片總大小不可超過 10 MiB");
      return;
    }
    if (documentFiles.some((file) => !SUPPORTED_DOCUMENT_EXTENSIONS.has(fileExtension(file.name)))) {
      setError("只支援文字、Markdown、CSV、JSON、HTML、XML、YAML、PDF 與 Office 文件");
      return;
    }
    if (documentFiles.some((file) => file.size > MAX_DOCUMENT_BYTES)) {
      setError("每份文件不可超過 10 MiB");
      return;
    }
    if (documents.reduce((sum, document) => sum + document.size, 0) + documentFiles.reduce((sum, file) => sum + file.size, 0) > MAX_TOTAL_DOCUMENT_BYTES) {
      setError("文件總大小不可超過 20 MiB");
      return;
    }
    try {
      const [addedImages, addedDocuments] = await Promise.all([
        Promise.all(imageFiles.map(readComposerImage)),
        Promise.all(documentFiles.map(readComposerDocument)),
      ]);
      if (sessionOwnerRef.current !== owner) {
        updateCachedSession(owner, (session) => ({ ...session, images: [...session.images, ...addedImages], documents: [...session.documents, ...addedDocuments], error: null }));
        return;
      }
      setImages((current) => [...current, ...addedImages]);
      setDocuments((current) => [...current, ...addedDocuments]);
      setError(null);
      requestAnimationFrame(() => inputRef.current?.focus());
    } catch {
      if (sessionOwnerRef.current !== owner) {
        updateCachedSession(owner, (session) => ({ ...session, error: "無法讀取附件" }));
        return;
      }
      setError("無法讀取附件");
    }
  }

  const hasContent = Boolean(draft.trim() || images.length || documents.length);
  const hasAttachments = images.length > 0 || documents.length > 0;

  return (
    <form ref={formRef} className={`command-composer ${focusMode ? "command-composer--focus" : ""} ${hasAttachments ? "command-composer--attachments" : ""}`} data-session-key={sessionKey} aria-label={focusMode ? "專注模式指令輸入" : undefined} onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      {hasAttachments && <div className="command-composer__attachments" aria-label="待傳送附件">
        {images.map((image, index) => <div className="command-composer__attachment" key={image.id}>
          <img src={image.previewUrl} alt={`圖片 ${index + 1}：${image.name}`} />
          <span>IMG {index + 1}</span>
          <button type="button" aria-label={`移除圖片 ${index + 1}`} onClick={() => setImages((current) => current.filter((item) => item.id !== image.id))}>×</button>
        </div>)}
        {documents.map((document, index) => <div className="command-composer__attachment command-composer__attachment--document" key={document.id} title={document.name}>
          <strong>{documentBadge(document.name)}</strong>
          <em>{document.name}</em>
          <span>FILE {index + 1}</span>
          <button type="button" aria-label={`移除文件 ${index + 1}`} onClick={() => setDocuments((current) => current.filter((item) => item.id !== document.id))}>×</button>
        </div>)}
      </div>}
      {paletteOpen && (
        <div className="command-palette" role="listbox" aria-label={`${provider} 指令面板`}>
          <div className="command-palette__head"><span>{provider === "claude" ? "CLAUDE COMMANDS" : "CODEX COMMANDS + SKILLS"}</span><kbd>Esc</kbd></div>
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
      <input ref={fileInputRef} className="command-composer__file-input" type="file" multiple accept={FILE_ACCEPT} onChange={(event) => {
        const files = Array.from(event.currentTarget.files ?? []);
        event.currentTarget.value = "";
        void attachFiles(files);
      }} />
      <button className="command-composer__attach" type="button" onClick={() => fileInputRef.current?.click()} title="附加圖片或文件" aria-label="附加圖片或文件">＋</button>
      <span className="command-composer__prompt">›</span>
      <textarea
        ref={inputRef}
        autoFocus={focusRequest > 0}
        value={draft}
        rows={1}
        spellCheck={false}
        disabled={!active || !authReady}
        aria-busy={Boolean(active?.busy)}
        placeholder={active?.busy ? `${active.name} 執勤中，可輸入或附加檔案排隊…` : `對 ${active?.name ?? "…"} 下指令（可附加圖片或文件）`}
        aria-label="輸入 Agent 指令"
        onPaste={(event) => {
          const files = Array.from(event.clipboardData.items).map((item) => item.kind === "file" ? item.getAsFile() : null).filter((file): file is File => Boolean(file));
          if (files.length > 0) {
            event.preventDefault();
            void attachFiles(files);
          }
        }}
        onCompositionStart={() => { composingRef.current = true; }}
        onCompositionEnd={() => { composingRef.current = false; }}
        onChange={(event) => {
          const value = event.target.value;
          setDraft(value);
          setError(null);
          setHistoryIndex(-1);
          if (["/", "$"].some((prefix) => value === prefix || (value.startsWith(prefix) && !value.includes(" ")))) onPaletteOpen(true);
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

function documentPayload(document: ComposerDocument): MessageDocumentPayload {
  return { name: document.name, mimeType: document.mimeType, dataBase64: document.dataBase64 };
}

async function readComposerImage(file: File): Promise<ComposerImage> {
  const previewUrl = await readFileDataUrl(file);
  const dataBase64 = previewUrl.slice(previewUrl.indexOf(",") + 1);
  return {
    id: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`,
    name: file.name || `clipboard-${Date.now()}`,
    mimeType: (file.type || imageMimeType(file.name)) as ComposerImage["mimeType"],
    dataBase64,
    previewUrl,
    size: file.size,
  };
}

async function readComposerDocument(file: File): Promise<ComposerDocument> {
  const dataUrl = await readFileDataUrl(file);
  return {
    id: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`,
    name: file.name,
    mimeType: file.type || documentMimeType(file.name),
    dataBase64: dataUrl.slice(dataUrl.indexOf(",") + 1),
    size: file.size,
  };
}

function readFileDataUrl(file: File): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("invalid attachment"));
    reader.onerror = () => reject(reader.error ?? new Error("attachment read failed"));
    reader.readAsDataURL(file);
  });
}

function fileExtension(name: string): string {
  return name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
}

function isImageFile(file: File): boolean {
  return file.type.startsWith("image/") || ["png", "jpg", "jpeg", "webp"].includes(fileExtension(file.name));
}

function imageMimeType(name: string): string {
  const extension = fileExtension(name);
  return extension === "png" ? "image/png" : ["jpg", "jpeg"].includes(extension) ? "image/jpeg" : "image/webp";
}

function documentBadge(name: string): string {
  const extension = fileExtension(name);
  return extension === "md" ? "MD" : extension === "pdf" ? "PDF" : extension.startsWith("doc") ? "DOC" : extension.startsWith("xls") ? "XLS" : extension.startsWith("ppt") ? "PPT" : extension.slice(0, 4).toUpperCase() || "FILE";
}

function documentMimeType(name: string): string {
  const extension = fileExtension(name);
  if (["txt", "log"].includes(extension)) return "text/plain";
  if (extension === "md") return "text/markdown";
  if (extension === "csv") return "text/csv";
  if (extension === "json") return "application/json";
  if (["html", "htm"].includes(extension)) return "text/html";
  if (extension === "xml") return "application/xml";
  if (["yaml", "yml"].includes(extension)) return "application/yaml";
  if (extension === "pdf") return "application/pdf";
  if (extension === "docx") return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (extension === "xlsx") return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  if (extension === "pptx") return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
  return "application/octet-stream";
}
