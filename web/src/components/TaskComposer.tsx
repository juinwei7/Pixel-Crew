import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { composerTextareaHeight, insertVoiceTranscript, newClientMessageIdentity, shouldSubmitComposerKey } from "../composerCore";
import { composerEnterAction } from "../commandInteraction";
import {
  documentBadge,
  documentPayload,
  FILE_ACCEPT,
  imagePayload,
  isImageFile,
  readComposerDocument,
  readComposerImage,
  validateComposerAttachment,
  type ComposerDocument,
  type ComposerImage,
} from "../composerFiles";
import { MAX_QUEUED_COMMANDS, moveQueuedItem, newQueueId, reorderQueuedItem, type QueuedCommand } from "../composerQueue";
import { useComposerDraft, writeComposerDraft } from "../hooks/useComposerDraft";
import { useComposerHistory } from "../hooks/useComposerHistory";
import { useComposerPalette, type PaletteItem } from "../hooks/useComposerPalette";
import { useComposerSessionExtras } from "../hooks/useComposerSessionExtras";
import { useGlobalFileDrop } from "../hooks/useGlobalFileDrop";
import { VoiceInputButton } from "./VoiceInputButton";
import type { CapabilityState, CommandSubmission, ProviderId, WorkerState } from "../types";
import { t } from "../i18n";

// 送出訊息後這段時間內的「空白 Enter＝中止任務」一律忽略，避免太快連按兩下 Enter 誤砍任務。
const INTERRUPT_GUARD_MS = 1000;

type PaletteConfig = {
  workspacePath: string;
  provider: ProviderId;
  capabilities: CapabilityState;
  open: boolean;
  onOpenChange(open: boolean): void;
  onManage(): void;
};

type HistoryConfig = {
  workers: WorkerState[];
  provider: ProviderId;
  workspacePath: string;
};

type Props = {
  draftKey: string;
  placeholder: string;
  submitLabel: string;
  busyLabel?: string;
  disabled?: boolean;
  working?: boolean;
  toolbar?: ReactNode;
  leading?: ReactNode;
  onSubmit(submission: CommandSubmission): Promise<string | null | void>;
  layout?: "inline" | "dock";
  focusMode?: boolean;
  focusRequest?: number;
  palette?: PaletteConfig;
  history?: HistoryConfig;
  queueEnabled?: boolean;
  busy?: boolean;
  onInterrupt?(): void;
  persistExtras?: boolean;
  globalDrop?: boolean;
  dropTargetLabel?: string;
  voiceEnabled?: boolean;
};

export function TaskComposer({
  draftKey, placeholder, submitLabel, busyLabel = t("處理中…"), disabled = false, working = false, toolbar, leading, onSubmit,
  layout = "inline", focusMode = false, focusRequest = 0, palette, history, queueEnabled = false, busy = false, onInterrupt,
  persistExtras = false, globalDrop = false, dropTargetLabel, voiceEnabled = false,
}: Props) {
  const dock = layout === "dock";
  const [draftValue, setDraftValue] = useComposerDraft(draftKey);
  const [failedFiles, setFailedFiles] = useState<File[]>([]);
  const {
    images, setImages, documents, setDocuments, queued, setQueued, error, setError,
    switchingSession, restoringExtras, extrasSaved, persistenceWarning, ownerRef, updateCachedSession,
  } = useComposerSessionExtras({ enabled: persistExtras, sessionKey: draftKey });
  const historyHook = useComposerHistory({
    enabled: Boolean(history),
    workers: history?.workers ?? [],
    provider: history?.provider ?? "claude",
    workspacePath: history?.workspacePath ?? "",
  });
  const formRef = useRef<HTMLFormElement>(null);
  const paletteHook = useComposerPalette({
    enabled: Boolean(palette),
    draft: draftValue,
    open: palette?.open ?? false,
    onOpenChange: palette?.onOpenChange ?? (() => {}),
    provider: palette?.provider ?? "claude",
    workspacePath: palette?.workspacePath ?? "",
    slashCommands: palette?.capabilities.slashCommands ?? [],
    history: historyHook.history,
    formRef,
  });
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const composingRef = useRef(false);
  const submittingRef = useRef(false);
  const lastSubmitAtRef = useRef(0);
  const wasBusyRef = useRef(busy);
  const dispatchingSessionsRef = useRef(new Set<string>());
  const [dispatchTick, setDispatchTick] = useState(0);
  const onSubmitRef = useRef(onSubmit);
  onSubmitRef.current = onSubmit;

  const { dragActive } = useGlobalFileDrop({
    enabled: globalDrop && dock,
    onFiles: (files) => void attachFiles(files),
  });

  useEffect(() => {
    setFailedFiles([]);
  }, [draftKey]);

  useEffect(() => {
    if (palette?.open) requestAnimationFrame(() => textareaRef.current?.focus());
  }, [palette?.open]);

  useEffect(() => {
    if (focusRequest <= 0 || disabled) return;
    const frame = requestAnimationFrame(() => textareaRef.current?.focus());
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRequest, draftKey, disabled]);

  useEffect(() => {
    if (wasBusyRef.current && !busy && !disabled) requestAnimationFrame(() => textareaRef.current?.focus());
    wasBusyRef.current = busy;
  }, [busy, disabled]);

  // Auto-dispatch the next queued command once the worker returns to idle.
  useEffect(() => {
    if (!queueEnabled || switchingSession || busy || disabled || queued.length === 0 || dispatchingSessionsRef.current.has(draftKey)) return;
    const next = queued[0];
    const owner = ownerRef.current;
    dispatchingSessionsRef.current.add(owner);
    setQueued((commands) => commands.slice(1));
    void onSubmitRef.current({ text: next.text, images: next.images.map(imagePayload), documents: next.documents.map(documentPayload), clientMessageId: next.clientMessageId, idempotencyKey: next.idempotencyKey })
      .then((result) => {
        const message = typeof result === "string" && result ? result : null;
        if (ownerRef.current !== owner) {
          if (message) writeComposerDraft(owner, next.text);
          updateCachedSession(owner, (session) => message
            ? { ...session, error: message, images: session.images.length ? session.images : next.images, documents: session.documents.length ? session.documents : next.documents }
            : { ...session, error: null });
          return;
        }
        if (message) {
          setError(message);
          setDraftValue((current) => current || next.text);
          setImages((current) => current.length ? current : next.images);
          setDocuments((current) => current.length ? current : next.documents);
        }
      })
      .catch((cause: unknown) => {
        const message = cause instanceof Error ? cause.message : t("排隊訊息送出失敗");
        if (ownerRef.current !== owner) {
          writeComposerDraft(owner, next.text);
          updateCachedSession(owner, (session) => ({
            ...session,
            error: message,
            images: session.images.length ? session.images : next.images,
            documents: session.documents.length ? session.documents : next.documents,
          }));
          return;
        }
        setError(message);
        setDraftValue((current) => current || next.text);
        setImages((current) => current.length ? current : next.images);
        setDocuments((current) => current.length ? current : next.documents);
      })
      .finally(() => {
        dispatchingSessionsRef.current.delete(owner);
        setDispatchTick((tick) => tick + 1);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queueEnabled, busy, disabled, queued, draftKey, switchingSession, dispatchTick]);

  async function attachFiles(files: File[]) {
    const owner = ownerRef.current;
    const imageFiles = files.filter(isImageFile);
    const documentFiles = files.filter((file) => !isImageFile(file));
    const validationError = validateComposerAttachment({ imageFiles, documentFiles, currentImages: images, currentDocuments: documents });
    if (validationError) {
      setError(validationError);
      return;
    }
    try {
      const [nextImages, nextDocuments] = await Promise.all([
        Promise.all(imageFiles.map(readComposerImage)),
        Promise.all(documentFiles.map(readComposerDocument)),
      ]);
      if (persistExtras && ownerRef.current !== owner) {
        updateCachedSession(owner, (session) => ({ ...session, images: [...session.images, ...nextImages], documents: [...session.documents, ...nextDocuments], error: null }));
        return;
      }
      setImages((current) => [...current, ...nextImages]);
      setDocuments((current) => [...current, ...nextDocuments]);
      setFailedFiles([]);
      setError(null);
      requestAnimationFrame(() => textareaRef.current?.focus());
    } catch {
      if (persistExtras && ownerRef.current !== owner) {
        updateCachedSession(owner, (session) => ({ ...session, error: t("附件讀取失敗，可重試") }));
        return;
      }
      setFailedFiles(files);
      setError(t("附件讀取失敗，可重試"));
    }
  }

  function choose(item: PaletteItem) {
    setDraftValue(item.value);
    historyHook.resetHistoryIndex();
    setError(null);
    palette?.onOpenChange(false);
    requestAnimationFrame(() => textareaRef.current?.focus());
  }

  async function submit() {
    if (disabled || switchingSession || submittingRef.current) return;
    if (palette?.open) return;
    const text = draftValue.trim();
    if (queueEnabled && busy) {
      if (!text && images.length === 0 && documents.length === 0) {
        // 防呆：剛送出訊息後 INTERRUPT_GUARD_MS 內的空白 Enter 視為誤觸（例如太快連按兩下
        // Enter：第一下送出、清空輸入框，第二下就落到這個「空送出＝中止任務」的分支），
        // 不要把剛派出去的任務直接砍掉。真的要中止請按「中止」鈕，或停頓一下再按 Enter。
        if (Date.now() - lastSubmitAtRef.current < INTERRUPT_GUARD_MS) return;
        onInterrupt?.();
        return;
      }
      if (queued.length >= MAX_QUEUED_COMMANDS) {
        setError(t("等待佇列最多 {max} 項", { max: MAX_QUEUED_COMMANDS }));
        return;
      }
      lastSubmitAtRef.current = Date.now();
      const command: QueuedCommand = { id: newQueueId(), text, images, documents, ...newClientMessageIdentity() };
      setDraftValue("");
      setImages([]);
      setDocuments([]);
      setError(null);
      setQueued((commands) => [...commands, command]);
      requestAnimationFrame(() => textareaRef.current?.focus());
      return;
    }
    if (working) return;
    if (!text && images.length === 0 && documents.length === 0) return;
    submittingRef.current = true;
    lastSubmitAtRef.current = Date.now();
    const owner = ownerRef.current;
    const identity = newClientMessageIdentity();
    const submission: CommandSubmission = { text, images: images.map(imagePayload), documents: documents.map(documentPayload), ...identity };
    setDraftValue("");
    setImages([]);
    setDocuments([]);
    setError(null);
    palette?.onOpenChange(false);
    requestAnimationFrame(() => textareaRef.current?.focus());
    const result = await onSubmit(submission).catch((cause: unknown) => cause instanceof Error ? cause.message : t("訊息送出失敗"));
    submittingRef.current = false;
    const message = typeof result === "string" && result ? result : null;
    if (persistExtras && ownerRef.current !== owner) {
      if (message) writeComposerDraft(owner, text);
      updateCachedSession(owner, (session) => message
        ? { ...session, error: message, images: session.images.length ? session.images : images, documents: session.documents.length ? session.documents : documents }
        : { ...session, error: null });
      return;
    }
    setError(message);
    if (message) {
      setDraftValue((current) => current || text);
      setImages((current) => current.length ? current : images);
      setDocuments((current) => current.length ? current : documents);
    }
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    const isComposing = composingRef.current || event.nativeEvent.isComposing || event.keyCode === 229;
    if (isComposing) return;
    if (palette && event.key === "Escape") {
      palette.onOpenChange(false);
      return;
    }
    if (palette?.open && paletteHook.items.length > 0) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        paletteHook.setSelected((index) => event.key === "ArrowDown" ? (index + 1) % paletteHook.items.length : (index - 1 + paletteHook.items.length) % paletteHook.items.length);
        return;
      }
      if (event.key === "Tab") {
        event.preventDefault();
        choose(paletteHook.items[paletteHook.selected] ?? paletteHook.items[0]);
        return;
      }
    }
    // 已移除「↑/↓ 叫回上一句指令」的功能：它在單行草稿時會直接用歷史紀錄蓋掉你正在打、
    // 還沒送出的內容，導致辛苦打的字瞬間消失、得重打（使用者回報的痛點）。歷史指令仍可從
    // 指令面板（⌘/Ctrl K）的「最近」區塊取用，不會誤觸。現在 ↑/↓ 回歸單純的游標移動。
    if (event.key === "Enter") {
      if (event.repeat) {
        event.preventDefault();
        return;
      }
      if (palette) {
        const action = composerEnterAction(palette.open, paletteHook.libraryLoading, paletteHook.items.length, event.shiftKey);
        if (action === "ignore" && event.shiftKey) return;
        event.preventDefault();
        if (action === "choose") choose(paletteHook.items[paletteHook.selected] ?? paletteHook.items[0]);
        else if (action === "submit") void submit();
        return;
      }
      if (shouldSubmitComposerKey({ key: event.key, shiftKey: event.shiftKey, isComposing, repeat: event.repeat })) {
        event.preventDefault();
        void submit();
      }
    }
  }

  const hasContent = Boolean(draftValue.trim() || images.length || documents.length);
  const hasAttachments = images.length > 0 || documents.length > 0;
  const canInterrupt = queueEnabled && busy && !hasContent;
  const submitDisabled = disabled || (working && !queueEnabled) || (!hasContent && !canInterrupt);
  const submitLabelToShow = canInterrupt ? t("中止") : queueEnabled && busy && hasContent ? t("排隊") : working ? busyLabel : submitLabel;

  const attachmentsBlock = hasAttachments && (
    dock ? <div className="command-composer__attachments" aria-label={t("待傳送附件")}>
      {images.map((image, index) => <div className="command-composer__attachment" key={image.id}>
        <img src={image.previewUrl} alt={t("圖片 {n}：{name}", { n: index + 1, name: image.name })} />
        <span>IMG {index + 1}</span>
        <button type="button" aria-label={t("移除圖片 {n}", { n: index + 1 })} onClick={() => setImages((current) => current.filter((item) => item.id !== image.id))}>×</button>
      </div>)}
      {documents.map((document, index) => <div className="command-composer__attachment command-composer__attachment--document" key={document.id} title={document.name}>
        <strong>{documentBadge(document.name)}</strong>
        <em>{document.name}</em>
        <span>FILE {index + 1}</span>
        <button type="button" aria-label={t("移除文件 {n}", { n: index + 1 })} onClick={() => setDocuments((current) => current.filter((item) => item.id !== document.id))}>×</button>
      </div>)}
    </div> : <div className="task-composer__attachments">
      {images.map((image) => <div key={image.id} className="task-composer__attachment"><img src={image.previewUrl} alt={image.name} /><span>{image.name}</span><button type="button" aria-label={t("移除 {name}", { name: image.name })} onClick={() => setImages((current) => current.filter((item) => item.id !== image.id))}>×</button></div>)}
      {documents.map((document) => <div key={document.id} className="task-composer__attachment task-composer__attachment--file"><strong>{documentBadge(document.name)}</strong><span>{document.name}</span><button type="button" aria-label={t("移除 {name}", { name: document.name })} onClick={() => setDocuments((current) => current.filter((item) => item.id !== document.id))}>×</button></div>)}
    </div>
  );

  const fileInput = <input ref={fileRef} hidden={!dock} className={dock ? "command-composer__file-input" : undefined} type="file" accept={FILE_ACCEPT} multiple onChange={(event) => {
    const files = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = "";
    void attachFiles(files);
  }} />;

  const textareaField = <textarea
    ref={textareaRef}
    autoFocus={dock && focusRequest > 0}
    value={draftValue}
    rows={1}
    spellCheck={false}
    disabled={disabled || (working && !queueEnabled)}
    aria-busy={Boolean(busy || working)}
    placeholder={placeholder}
    aria-label={dock ? "輸入 Agent 指令" : undefined}
    style={dock ? undefined : { height: composerTextareaHeight(draftValue) }}
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
      setDraftValue(value);
      setError(null);
      if (history) historyHook.resetHistoryIndex();
      if (palette && ["/", "$"].some((prefix) => value === prefix || (value.startsWith(prefix) && !value.includes(" ")))) palette.onOpenChange(true);
    }}
    onKeyDown={onKeyDown}
  />;

  if (dock) {
    return <>
      {dragActive && typeof document !== "undefined" && createPortal(
        <div className="file-drop-overlay" role="status" aria-live="polite">
          <div className="file-drop-overlay__card">
            <span className="file-drop-overlay__icon" aria-hidden="true">＋</span>
            <strong>{globalDrop ? t("放開即可附加") : t("目前視窗不接收附件")}</strong>
            <small>{globalDrop ? t("圖片與文件會加入 {target} 的這則訊息", { target: dropTargetLabel ?? t("目前 NPC") }) : t("請先關閉目前的編輯或設定視窗")}</small>
          </div>
        </div>,
        document.body,
      )}
      <form ref={formRef} className={`command-composer ${focusMode ? "command-composer--focus" : ""} ${hasAttachments ? "command-composer--attachments" : ""}`} data-session-key={draftKey} data-file-drop-owner="task-composer" aria-label={focusMode ? t("專注模式指令輸入") : undefined} onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        {attachmentsBlock}
        {toolbar && <div className="command-composer__toolbar">{toolbar}</div>}
        {palette?.open && (
          <div className="command-palette" role="listbox" aria-label={t("{provider} 指令面板", { provider: palette.provider })}>
            <div className="command-palette__head"><span>{palette.provider === "claude" ? "CLAUDE COMMANDS" : "CODEX COMMANDS + SKILLS"}</span><kbd>Esc</kbd></div>
            <div className="command-palette__items">
              {paletteHook.libraryLoading && <div className="command-palette__skeleton"><i /><i /><i /></div>}
              {!paletteHook.libraryLoading && paletteHook.items.map((item, index) => (
                <button key={item.key} type="button" role="option" aria-selected={index === paletteHook.selected} className={index === paletteHook.selected ? "command-palette__item--active" : ""} onMouseEnter={() => paletteHook.setSelected(index)} onClick={() => choose(item)}>
                  <strong>{item.label}</strong><small>{item.description}</small><span>{item.kind === "recent" ? "↺" : "↵"}</span>
                </button>
              ))}
              {!paletteHook.libraryLoading && paletteHook.items.length === 0 && <div className="command-palette__empty">{t("找不到相符指令")}</div>}
            </div>
            <button className="command-palette__manage" type="button" onClick={palette.onManage}>{t("管理 {label}…", { label: palette.provider === "claude" ? t("Claude 指令") : t("Codex 工作流") })}</button>
          </div>
        )}
        {palette && <button className="command-composer__library" type="button" onClick={() => palette.onOpenChange(!palette.open)} aria-expanded={palette.open} title={t("指令面板（⌘/Ctrl K）")}>
          ⌘ <span>{palette.provider === "claude" ? "CLAUDE" : "CODEX"}</span>
        </button>}
        {leading}
        {fileInput}
        <button className="command-composer__attach" type="button" onClick={() => fileRef.current?.click()} title={t("附加圖片或文件")} aria-label={t("附加圖片或文件")}>＋</button>
        {voiceEnabled && !disabled && <VoiceInputButton onTranscript={(text) => {
          setDraftValue((current) => insertVoiceTranscript(current, text));
          requestAnimationFrame(() => textareaRef.current?.focus());
        }} />}
        <span className="command-composer__prompt">›</span>
        {textareaField}
        {error && <span className="command-composer__error" role="alert">{error}</span>}
        {persistenceWarning && <span className="command-composer__error command-composer__error--storage" role="alert">{persistenceWarning}</span>}
        {queueEnabled && queued.length > 0 && <QueuePanel queued={queued} restoringExtras={restoringExtras} extrasSaved={extrasSaved}
          onEdit={(index) => {
            const target = queued[index];
            if (!target) return;
            const replacement = hasContent ? { ...target, text: draftValue, images, documents } : null;
            setQueued((commands) => replacement
              ? commands.map((command, commandIndex) => commandIndex === index ? replacement : command)
              : commands.filter((_, commandIndex) => commandIndex !== index));
            setDraftValue(target.text);
            setImages(target.images);
            setDocuments(target.documents);
            setError(null);
            requestAnimationFrame(() => textareaRef.current?.focus());
          }}
          onMove={(index, offset) => setQueued((commands) => moveQueuedItem(commands, index, offset))}
          onReorder={(from, to) => setQueued((commands) => reorderQueuedItem(commands, from, to))}
          onCancel={(id) => setQueued((commands) => commands.filter((item) => item.id !== id))}
        />}
        <button className={`command-composer__submit ${canInterrupt ? "command-composer__submit--stop" : ""}`} type="submit" disabled={submitDisabled}>{submitLabelToShow}</button>
      </form>
    </>;
  }

  return <form ref={formRef} className="task-composer" data-file-drop-owner="task-composer" onSubmit={(event) => { event.preventDefault(); void submit(); }} onDragOver={(event) => {
    if (Array.from(event.dataTransfer.types).includes("Files")) { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; }
  }} onDrop={(event) => {
    if (!Array.from(event.dataTransfer.types).includes("Files")) return;
    event.preventDefault();
    void attachFiles(Array.from(event.dataTransfer.files));
  }}>
    {toolbar && <div className="task-composer__toolbar">{toolbar}</div>}
    {attachmentsBlock}
    <div className="task-composer__row">
      {leading}
      {fileInput}
      <button className="task-composer__attach" type="button" aria-label={t("附加圖片或文件")} title={t("附加圖片或文件")} onClick={() => fileRef.current?.click()}>＋</button>
      <span className="task-composer__prompt" aria-hidden="true">›</span>
      {textareaField}
      <button className="task-composer__submit" type="submit" disabled={submitDisabled}>{submitLabelToShow}</button>
    </div>
    {error && <div className="task-composer__error" role="alert">{error}{failedFiles.length > 0 && <button type="button" onClick={() => void attachFiles(failedFiles)}>{t("重試附件")}</button>}</div>}
  </form>;
}

function QueuePanel({ queued, restoringExtras, extrasSaved, onEdit, onMove, onReorder, onCancel }: {
  queued: QueuedCommand[];
  restoringExtras: boolean;
  extrasSaved: boolean;
  onEdit(index: number): void;
  onMove(index: number, offset: -1 | 1): void;
  onReorder(from: number, to: number): void;
  onCancel(id: string): void;
}) {
  const [open, setOpen] = useState(false);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  return <>
    <button type="button" className="command-composer__queue" aria-expanded={open} onClick={() => setOpen((value) => !value)}>{t("等待 {count}", { count: queued.length })}</button>
    {open && <div className="command-queue" aria-label={t("待送訊息佇列")}>
      <header><div><span>UP NEXT</span><strong>{t("待送訊息")} {restoringExtras ? t("· 復原中…") : extrasSaved ? t("· 已保存") : t("· 保存中…")}</strong></div><button type="button" aria-label={t("關閉待送訊息")} onClick={() => setOpen(false)}>×</button></header>
      <ol>{queued.map((command, index) => <li key={command.id} className={dragIndex === index ? "command-queue__item--dragging" : ""} onDragOver={(event) => { if (dragIndex !== null) event.preventDefault(); }} onDrop={(event) => {
        if (dragIndex === null) return;
        event.preventDefault();
        onReorder(dragIndex, index);
        setDragIndex(null);
      }}>
        <span className="command-queue__drag" draggable title={t("拖曳調整順序")} aria-hidden="true" onDragStart={(event) => { event.dataTransfer.effectAllowed = "move"; setDragIndex(index); }} onDragEnd={() => setDragIndex(null)}>⠿</span>
        <button type="button" className="command-queue__edit" onClick={() => { onEdit(index); setOpen(false); }} title={t("載入編輯")}>
          <strong>{command.text || t("只有附件的訊息")}</strong>
          <small>{command.images.length > 0 ? t("{n} 張圖片", { n: command.images.length }) : ""}{command.images.length > 0 && command.documents.length > 0 ? " · " : ""}{command.documents.length > 0 ? t("{n} 份文件", { n: command.documents.length }) : ""}</small>
        </button>
        <div className="command-queue__actions">
          <button type="button" disabled={index === 0} aria-label={t("往前移")} onClick={() => onMove(index, -1)}>↑</button>
          <button type="button" disabled={index === queued.length - 1} aria-label={t("往後移")} onClick={() => onMove(index, 1)}>↓</button>
          <button type="button" aria-label={t("取消待送訊息")} onClick={() => onCancel(command.id)}>×</button>
        </div>
      </li>)}</ol>
      <footer>{t("點選內容可載入編輯；目前草稿會與該項目交換。")}</footer>
    </div>}
  </>;
}
