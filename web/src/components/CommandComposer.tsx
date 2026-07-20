import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CapabilityState, CommandSubmission, MessageDocumentPayload, MessageImagePayload, ProviderId, WorkerState } from "../types";
import { apiRequest } from "../api";
import { deriveCommandHistory } from "../commandHistory";
import { buildProviderWorkflowEntries, composerEnterAction } from "../commandInteraction";

type PaletteItem = { key: string; label: string; description: string; value: string; kind: "recent" | "project" };
type LibraryEntry = { name: string; description: string; argumentHint?: string };
type ComposerImage = MessageImagePayload & { id: string; previewUrl: string; size: number };
type ComposerDocument = MessageDocumentPayload & { id: string; size: number };
type QueuedCommand = { id: string; text: string; images: ComposerImage[]; documents: ComposerDocument[] };
type ComposerSession = { draft: string; images: ComposerImage[]; documents: ComposerDocument[]; queued: QueuedCommand[]; error: string | null };
type PersistedComposerExtras = Pick<ComposerSession, "images" | "documents" | "queued">;

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
const DRAFT_STORAGE_KEY = "pixel-crew-composer-drafts-v1";
const COMPOSER_DB_NAME = "pixel-crew-composer";
const COMPOSER_DB_STORE = "session-extras";

export function dragContainsFiles(dataTransfer: Pick<DataTransfer, "types"> | null | undefined): boolean {
  return Array.from(dataTransfer?.types ?? []).includes("Files");
}

export function moveQueuedItem<T>(items: T[], index: number, offset: -1 | 1): T[] {
  const target = index + offset;
  if (index < 0 || index >= items.length || target < 0 || target >= items.length) return items;
  const next = [...items];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

export function reorderQueuedItem<T>(items: T[], from: number, to: number): T[] {
  if (from < 0 || from >= items.length || to < 0 || to >= items.length || from === to) return items;
  const next = [...items];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

export function mergeComposerItems<T extends { id: string }>(saved: T[], current: T[]): T[] {
  const merged = new Map(saved.map((item) => [item.id, item]));
  for (const item of current) merged.set(item.id, item);
  return [...merged.values()];
}

type Props = {
  active?: WorkerState;
  workers: WorkerState[];
  workspacePath: string;
  capabilities: CapabilityState;
  authReady: boolean;
  focusMode?: boolean;
  sessionKey?: string;
  globalDropEnabled?: boolean;
  paletteOpen: boolean;
  focusRequest?: number;
  onPaletteOpen(open: boolean): void;
  onSubmit(command: CommandSubmission): Promise<string | null>;
  onInterrupt(): void;
  onManage(): void;
};

export function CommandComposer({ active, workers, workspacePath, capabilities, authReady, focusMode = false, sessionKey = "default", globalDropEnabled = true, paletteOpen, focusRequest = 0, onPaletteOpen, onSubmit, onInterrupt, onManage }: Props) {
  const [draft, setDraft] = useState(() => loadPersistedDraft(sessionKey));
  const [selected, setSelected] = useState(0);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [error, setError] = useState<string | null>(null);
  const [images, setImages] = useState<ComposerImage[]>([]);
  const [documents, setDocuments] = useState<ComposerDocument[]>([]);
  const [queued, setQueued] = useState<QueuedCommand[]>([]);
  const [library, setLibrary] = useState<LibraryEntry[]>([]);
  const [libraryLoading, setLibraryLoading] = useState(false);
  const [dispatchTick, setDispatchTick] = useState(0);
  const [fileDragActive, setFileDragActive] = useState(false);
  const [queueOpen, setQueueOpen] = useState(false);
  const [queueDragIndex, setQueueDragIndex] = useState<number | null>(null);
  const [restoringExtras, setRestoringExtras] = useState(false);
  const [extrasSaved, setExtrasSaved] = useState(true);
  const [persistenceWarning, setPersistenceWarning] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const wasBusyRef = useRef(Boolean(active?.busy));
  const dispatchingSessionsRef = useRef(new Set<string>());
  const fileDragDepthRef = useRef(0);
  const attachFilesRef = useRef<(files: File[]) => Promise<void>>(async () => {});
  const globalDropEnabledRef = useRef(globalDropEnabled);
  const hydratedExtrasRef = useRef(new Set<string>());
  const extrasSaveRevisionRef = useRef(0);
  const sessionCacheRef = useRef(new Map<string, ComposerSession>());
  const sessionOwnerRef = useRef(sessionKey);
  const onSubmitRef = useRef(onSubmit);
  onSubmitRef.current = onSubmit;
  globalDropEnabledRef.current = globalDropEnabled;
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
    const previousOwner = sessionOwnerRef.current;
    sessionCacheRef.current.set(previousOwner, { draft, images, documents, queued, error });
    if (hydratedExtrasRef.current.has(previousOwner)) {
      void saveComposerExtras(previousOwner, { images, documents, queued }).catch(() => setPersistenceWarning("上一個 NPC 的附件與待送訊息無法保存"));
    }
    const next = sessionCacheRef.current.get(sessionKey) ?? { draft: loadPersistedDraft(sessionKey), images: [], documents: [], queued: [], error: null };
    sessionOwnerRef.current = sessionKey;
    setDraft(next.draft);
    setImages(next.images);
    setDocuments(next.documents);
    setQueued(next.queued);
    setError(next.error);
    setSelected(0);
    setHistoryIndex(-1);
    setQueueOpen(false);
    onPaletteOpen(false);
  }, [sessionKey, switchingSession]);

  useEffect(() => {
    let cancelled = false;
    const owner = sessionKey;
    setRestoringExtras(true);
    void loadComposerExtras(owner).then((saved) => {
      if (cancelled || sessionOwnerRef.current !== owner) return;
      if (saved) {
        setImages((current) => mergeComposerItems(saved.images, current));
        setDocuments((current) => mergeComposerItems(saved.documents, current));
        setQueued((current) => mergeComposerItems(saved.queued, current));
      }
      hydratedExtrasRef.current.add(owner);
      setExtrasSaved(true);
      setPersistenceWarning(null);
    }).catch(() => {
      if (!cancelled) setPersistenceWarning("附件與待送訊息無法從本機儲存空間復原");
      hydratedExtrasRef.current.add(owner);
    }).finally(() => {
      if (!cancelled) setRestoringExtras(false);
    });
    return () => { cancelled = true; };
  }, [sessionKey]);

  useEffect(() => {
    if (switchingSession) return;
    const owner = sessionOwnerRef.current;
    if (!hydratedExtrasRef.current.has(owner)) return;
    const revision = extrasSaveRevisionRef.current + 1;
    extrasSaveRevisionRef.current = revision;
    setExtrasSaved(false);
    const snapshot = { images, documents, queued };
    const timer = window.setTimeout(() => {
      void saveComposerExtras(owner, snapshot).then(() => {
        if (sessionOwnerRef.current === owner && extrasSaveRevisionRef.current === revision) {
          setExtrasSaved(true);
          setPersistenceWarning(null);
        }
      }).catch(() => {
        if (sessionOwnerRef.current === owner && extrasSaveRevisionRef.current === revision) setPersistenceWarning("附件與待送訊息無法保存，離開前請先送出");
      });
    }, 300);
    return () => window.clearTimeout(timer);
  }, [documents, images, queued, switchingSession]);

  useEffect(() => {
    if (switchingSession) return;
    const owner = sessionOwnerRef.current;
    const timer = window.setTimeout(() => persistDraft(owner, draft), 250);
    return () => window.clearTimeout(timer);
  }, [draft, switchingSession]);

  useEffect(() => {
    const hasUnsavedExtras = images.length > 0 || documents.length > 0 || queued.length > 0;
    if (!hasUnsavedExtras || extrasSaved) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [documents.length, extrasSaved, images.length, queued.length]);

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
    const command = { id: newQueueId(), text, images, documents };
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
  attachFilesRef.current = attachFiles;

  function editQueued(index: number) {
    const target = queued[index];
    if (!target) return;
    const replacement = hasContent ? { id: target.id, text: draft, images, documents } : null;
    setQueued((commands) => replacement
      ? commands.map((command, commandIndex) => commandIndex === index ? replacement : command)
      : commands.filter((_, commandIndex) => commandIndex !== index));
    setDraft(target.text);
    setImages(target.images);
    setDocuments(target.documents);
    setError(null);
    setQueueOpen(false);
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  function moveQueued(index: number, offset: -1 | 1) {
    setQueued((commands) => moveQueuedItem(commands, index, offset));
  }

  useEffect(() => {
    const clearDragState = () => {
      fileDragDepthRef.current = 0;
      setFileDragActive(false);
    };
    const ownedByAnotherDropZone = (event: DragEvent) => event.target instanceof Element && Boolean(event.target.closest("[data-file-drop-owner]"));
    const enter = (event: DragEvent) => {
      if (!dragContainsFiles(event.dataTransfer)) return;
      if (ownedByAnotherDropZone(event)) {
        clearDragState();
        return;
      }
      event.preventDefault();
      fileDragDepthRef.current += 1;
      setFileDragActive(true);
    };
    const over = (event: DragEvent) => {
      if (!dragContainsFiles(event.dataTransfer)) return;
      if (ownedByAnotherDropZone(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    };
    const leave = (event: DragEvent) => {
      if (!dragContainsFiles(event.dataTransfer)) return;
      if (ownedByAnotherDropZone(event)) return;
      event.preventDefault();
      fileDragDepthRef.current = Math.max(0, fileDragDepthRef.current - 1);
      if (fileDragDepthRef.current === 0) setFileDragActive(false);
    };
    const drop = (event: DragEvent) => {
      if (!dragContainsFiles(event.dataTransfer)) return;
      if (ownedByAnotherDropZone(event)) return;
      event.preventDefault();
      const files = Array.from(event.dataTransfer?.files ?? []);
      clearDragState();
      if (globalDropEnabledRef.current && files.length > 0) void attachFilesRef.current(files);
    };
    const blur = () => clearDragState();

    window.addEventListener("dragenter", enter);
    window.addEventListener("dragover", over);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragover", over);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop);
      window.removeEventListener("blur", blur);
    };
  }, []);

  useEffect(() => {
    if (!globalDropEnabled) setFileDragActive(false);
  }, [globalDropEnabled]);

  const hasContent = Boolean(draft.trim() || images.length || documents.length);
  const hasAttachments = images.length > 0 || documents.length > 0;

  return (
    <>
      {fileDragActive && typeof document !== "undefined" && createPortal(
        <div className="file-drop-overlay" role="status" aria-live="polite">
          <div className="file-drop-overlay__card">
            <span className="file-drop-overlay__icon" aria-hidden="true">＋</span>
            <strong>{globalDropEnabled ? "放開即可附加" : "目前視窗不接收附件"}</strong>
            <small>{globalDropEnabled ? `圖片與文件會加入 ${active?.name ?? "目前 NPC"} 的這則訊息` : "請先關閉目前的編輯或設定視窗"}</small>
          </div>
        </div>,
        document.body,
      )}
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
      {persistenceWarning && <span className="command-composer__error command-composer__error--storage" role="alert">{persistenceWarning}</span>}
      {queued.length > 0 && <button type="button" className="command-composer__queue" aria-expanded={queueOpen} onClick={() => setQueueOpen((open) => !open)}>等待 {queued.length}</button>}
      {queueOpen && queued.length > 0 && <div className="command-queue" aria-label="待送訊息佇列">
        <header><div><span>UP NEXT</span><strong>待送訊息 {restoringExtras ? "· 復原中…" : extrasSaved ? "· 已保存" : "· 保存中…"}</strong></div><button type="button" aria-label="關閉待送訊息" onClick={() => setQueueOpen(false)}>×</button></header>
        <ol>{queued.map((command, index) => <li key={command.id} className={queueDragIndex === index ? "command-queue__item--dragging" : ""} onDragOver={(event) => { if (queueDragIndex !== null) event.preventDefault(); }} onDrop={(event) => {
          if (queueDragIndex === null) return;
          event.preventDefault();
          setQueued((commands) => reorderQueuedItem(commands, queueDragIndex, index));
          setQueueDragIndex(null);
        }}>
          <span className="command-queue__drag" draggable title="拖曳調整順序" aria-hidden="true" onDragStart={(event) => { event.dataTransfer.effectAllowed = "move"; setQueueDragIndex(index); }} onDragEnd={() => setQueueDragIndex(null)}>⠿</span>
          <button type="button" className="command-queue__edit" onClick={() => editQueued(index)} title="載入編輯">
            <strong>{command.text || "只有附件的訊息"}</strong>
            <small>{command.images.length > 0 ? `${command.images.length} 張圖片` : ""}{command.images.length > 0 && command.documents.length > 0 ? " · " : ""}{command.documents.length > 0 ? `${command.documents.length} 份文件` : ""}</small>
          </button>
          <div className="command-queue__actions">
            <button type="button" disabled={index === 0} aria-label="往前移" onClick={() => moveQueued(index, -1)}>↑</button>
            <button type="button" disabled={index === queued.length - 1} aria-label="往後移" onClick={() => moveQueued(index, 1)}>↓</button>
            <button type="button" aria-label="取消待送訊息" onClick={() => setQueued((commands) => commands.filter((item) => item.id !== command.id))}>×</button>
          </div>
        </li>)}</ol>
        <footer>點選內容可載入編輯；目前草稿會與該項目交換。</footer>
      </div>}
      <button className={`command-composer__submit ${active?.busy && !hasContent ? "command-composer__submit--stop" : ""}`} type="submit" disabled={!active || !authReady || (!active.busy && !hasContent)}>
        {active?.busy ? (hasContent ? "排隊" : "中止") : "執行"}
      </button>
      </form>
    </>
  );
}

function imagePayload(image: ComposerImage): MessageImagePayload {
  return { name: image.name, mimeType: image.mimeType, dataBase64: image.dataBase64 };
}

function documentPayload(document: ComposerDocument): MessageDocumentPayload {
  return { name: document.name, mimeType: document.mimeType, dataBase64: document.dataBase64 };
}

function newQueueId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
}

function readDraftStore(): Record<string, string> {
  if (typeof window === "undefined") return {};
  try {
    const parsed = JSON.parse(window.localStorage.getItem(DRAFT_STORAGE_KEY) ?? "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function loadPersistedDraft(sessionKey: string): string {
  const value = readDraftStore()[sessionKey];
  return typeof value === "string" ? value : "";
}

function persistDraft(sessionKey: string, draft: string) {
  if (typeof window === "undefined") return;
  const drafts = readDraftStore();
  if (draft) drafts[sessionKey] = draft;
  else delete drafts[sessionKey];
  try {
    window.localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(drafts));
  } catch {
    // Draft persistence is best-effort when storage is unavailable or full.
  }
}

function openComposerDatabase(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(COMPOSER_DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(COMPOSER_DB_STORE)) request.result.createObjectStore(COMPOSER_DB_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("composer database unavailable"));
  });
}

async function loadComposerExtras(sessionKey: string): Promise<PersistedComposerExtras | null> {
  const database = await openComposerDatabase();
  if (!database) return null;
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(COMPOSER_DB_STORE, "readonly");
    const request = transaction.objectStore(COMPOSER_DB_STORE).get(sessionKey);
    request.onsuccess = () => {
      const value = request.result as Partial<PersistedComposerExtras> | undefined;
      resolve(value && Array.isArray(value.images) && Array.isArray(value.documents) && Array.isArray(value.queued)
        ? { images: value.images, documents: value.documents, queued: value.queued }
        : null);
    };
    request.onerror = () => reject(request.error ?? new Error("composer restore failed"));
    transaction.oncomplete = () => database.close();
    transaction.onabort = () => database.close();
  });
}

async function saveComposerExtras(sessionKey: string, extras: PersistedComposerExtras): Promise<void> {
  const database = await openComposerDatabase();
  if (!database) return;
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(COMPOSER_DB_STORE, "readwrite");
    transaction.objectStore(COMPOSER_DB_STORE).put(extras, sessionKey);
    transaction.oncomplete = () => { database.close(); resolve(); };
    transaction.onerror = () => { database.close(); reject(transaction.error ?? new Error("composer save failed")); };
    transaction.onabort = () => { database.close(); reject(transaction.error ?? new Error("composer save aborted")); };
  });
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
