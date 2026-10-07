import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { composerTextareaHeight, insertVoiceTranscript, newClientMessageIdentity, shouldSubmitComposerKey } from "../composerCore";
import { composerEnterAction, composerStatus, deferSubmitForVideo, emptySubmitAction, restoreFailedDraft, shouldAutoFocusComposer, videoAutoSendAction, type ComposerSubmitSource, type PendingVideoSend } from "../commandInteraction";
import { Icon } from "./Icon";
import {
  documentBadge,
  documentPayload,
  FILE_ACCEPT,
  imagePayload,
  detectVideoUrl,
  isImageFile,
  isVideoFile,
  MAX_DOCUMENTS,
  MAX_IMAGES,
  MAX_VIDEO_BYTES,
  readComposerDocument,
  readComposerImage,
  validateComposerAttachment,
  type ComposerDocument,
  type ComposerImage,
} from "../composerFiles";
import { legacyQueueRestore, MAX_QUEUED_COMMANDS, mergeComposerItems, moveQueuedItem, newQueueId, reorderQueuedItem, type QueuedCommand } from "../composerQueue";
import { useComposerDraft, writeComposerDraft } from "../hooks/useComposerDraft";
import { useComposerHistory } from "../hooks/useComposerHistory";
import { useComposerPalette, type PaletteItem } from "../hooks/useComposerPalette";
import { useComposerSessionExtras } from "../hooks/useComposerSessionExtras";
import { useGlobalFileDrop } from "../hooks/useGlobalFileDrop";
import { VoiceInputButton } from "./VoiceInputButton";
import type { CapabilityState, CommandSubmission, ProviderId, QueuedCommandDto, WorkerState } from "../types";
import type { ClientPoint } from "../fxBus";
import { t } from "../i18n";

// 空白 Enter 永遠不會中止任務（見 commandInteraction.emptySubmitAction）；只有按「中止」鈕才會。
// 按鈕在送出訊息後這段時間內也忽略，避免太快連點兩下誤砍剛派出的任務。
const INTERRUPT_GUARD_MS = 1000;

// 送出鈕的動態分段（styles/motion.css、r2-composer.css 依 data-launch 播放）：
// 成功：起飛 → 打勾 → 字浮回來；失敗：起飛 → 紙飛機折返 → 字浮回來（草稿同時放回輸入框）。
// 起飛至少播這麼久才換下一段，送出回應再快也看得到飛機離開。
const LAUNCH_MIN_MS = 420;
const LAUNCH_DONE_MS = 780;
const LAUNCH_RETURN_MS = 520;
const LAUNCH_SETTLE_MS = 300;
// 草稿的 localStorage 前綴（與 hooks/useComposerDraft 相同）：送出失敗時使用者已切到別的
// NPC，要把原文「併回」那位 NPC 的草稿，不能直接覆蓋他離開前新打的字。
const DRAFT_STORAGE_PREFIX = "pixel-crew:task-composer:";

function readStoredDraft(key: string): string {
  try { return typeof localStorage === "undefined" ? "" : localStorage.getItem(`${DRAFT_STORAGE_PREFIX}${key}`) ?? ""; } catch { return ""; }
}

/** 失敗退回的附件放前面、等待期間新加的接在後面（同 id 不重複），並守住上限。 */
export function mergeFailed<T extends { id: string }>(failed: T[], current: T[], max: number): T[] {
  if (failed.length === 0) return current;
  const seen = new Set(failed.map((item) => item.id));
  return [...failed, ...current.filter((item) => !seen.has(item.id))].slice(0, max);
}
// 「已交給 XXX」回執停留時間；跟 CSS 的倒數細線用同一個數字（--receipt-ms）。
const RECEIPT_MS = 4200;

export type LaunchPhase = "idle" | "launch" | "done" | "return" | "settle";

/** 外部（拖放到 NPC 身上、Ctrl+K 指令面板）要求「預填」這個輸入框：只填文字／
 *  加附件、聚焦，絕不自動送出。sessionKey 對上目前 draftKey 才套用——切換 NPC
 *  時草稿是分開存的，必須等輸入框切到目標 NPC 那一份才填進去。 */
export type ComposerInject = { seq: number; sessionKey: string; text: string; files: File[] };

/** 送出成功、要交給場景放紙飛機的那一刻。from 是送出鈕中心（viewport 座標）。 */
export type ComposerLaunch = { workerId: string; from: ClientPoint; text: string };

type LaunchTarget = { id: string; name: string };
type Receipt = { key: number; workerId: string; name: string; queued: boolean; leaving: boolean };

// /api/video/process 與 /api/video/from-link 的共同回應形狀（影格＋字幕）。
type VideoAnalysisResult = {
  images?: Array<{ name: string; mimeType: string; dataBase64: string }>;
  transcript?: string;
  transcriptError?: string | null;
};

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
  // 跨裝置排隊：提供 serverQueue + onEnqueue 就改走 server 佇列（畫面讀 server、送出交
  // 給 server drain），不再用瀏覽器本地佇列。只有 dock composer 會接這些。
  serverQueue?: QueuedCommandDto[];
  onEnqueue?(submission: CommandSubmission): Promise<string | null>;
  onRemoveQueued?(id: string): void;
  onReorderQueued?(orderedIds: string[]): void;
  persistExtras?: boolean;
  globalDrop?: boolean;
  dropTargetLabel?: string;
  voiceEnabled?: boolean;
  /** 目前這個輸入框送出的對象（dock composer 才有）：回執顯示名字、紙飛機飛向它。 */
  launchTarget?: LaunchTarget | null;
  onLaunch?(launch: ComposerLaunch): void;
  /** 點「已交給 XXX」回執：跳到那位 NPC。 */
  onReceiptOpen?(workerId: string): void;
  inject?: ComposerInject | null;
  /** 預填已套用：上層要把 inject 清掉——輸入框若重新掛載（切去老闆桌再回來），
   *  appliedInjectRef 會歸零，留著舊的 inject 會把同一批檔案再附加一次。 */
  onInjectApplied?(seq: number): void;
  /** 目前對象有事等你處理（待核准、循環問你…）：狀態列顯示「需要你」。只有 dock 顯示狀態列。 */
  needsAttention?: boolean;
};

export function TaskComposer({
  draftKey, placeholder, submitLabel, busyLabel = t("處理中…"), disabled = false, working = false, toolbar, leading, onSubmit,
  layout = "inline", focusMode = false, focusRequest = 0, palette, history, queueEnabled = false, busy = false, onInterrupt,
  serverQueue, onEnqueue, onRemoveQueued, onReorderQueued,
  persistExtras = false, globalDrop = false, dropTargetLabel, voiceEnabled = false,
  launchTarget = null, onLaunch, onReceiptOpen, inject = null, onInjectApplied, needsAttention = false,
}: Props) {
  const dock = layout === "dock";
  // 有 onEnqueue＝這個 composer 走 server 佇列（背景 drain＋跨裝置）；否則沿用本地佇列。
  const useServerQueue = queueEnabled && !!onEnqueue;
  const serverQueueItems = serverQueue ?? [];
  const [draftValue, setDraftValue] = useComposerDraft(draftKey);
  const [failedFiles, setFailedFiles] = useState<File[]>([]);
  // 解析中的影片，依 owner（哪位 NPC 的輸入框）分開記：一放進來就先冒一個「解析中」佔位晶片(閃爍)，
  // 解析完換成正式影片晶片。影片解析可並行（先丟一支、解析中再丟第二支/貼連結）：每批各算一個 job——
  // 否則先完成的那批會把旗標整個關掉＋清光所有晶片，自動送出會在第二支還沒解析完時就開火，影格與字幕全漏。
  // dock 輸入框只有一個、切 NPC 不重掛：只看／只等目前這位 NPC 自己的影片。
  const [videoJobs, setVideoJobs] = useState<Array<{ id: number; owner: string; names: string[] }>>([]);
  const videoJobSeqRef = useRef(0);
  const videoProcessing = videoJobs.some((job) => job.owner === draftKey);
  const processingVideoNames = videoJobs.filter((job) => job.owner === draftKey).flatMap((job) => job.names);
  // 使用者在影片還在解析時按了送出：記下是哪位 NPC 的，等他的影片都解析完自動送出，
  // 這樣文字＋影片(影格＋字幕)會「一起」送，不會漏掉影片。切走、按中止或解析失敗就取消（見 videoAutoSendAction）。
  const [pendingVideoSend, setPendingVideoSend] = useState<PendingVideoSend | null>(null);
  const beginVideoJob = (owner: string, names: string[]): number => {
    const id = ++videoJobSeqRef.current;
    setVideoJobs((jobs) => [...jobs, { id, owner, names }]);
    return id;
  };
  const endVideoJob = (id: number, owner: string, failed: boolean) => {
    setVideoJobs((jobs) => jobs.filter((job) => job.id !== id));
    if (failed) setPendingVideoSend((pending) => pending?.owner === owner ? { ...pending, failed: true } : pending);
  };
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
  /** 聚焦輸入框。auto＝不是使用者剛在輸入框上操作（點 NPC、任務結束、送出後…）：
   *  觸控裝置一律不自動聚焦，免得螢幕鍵盤突然彈出來蓋住畫面。 */
  const focusTextarea = (auto = true) => {
    if (auto && !shouldAutoFocusComposer()) return;
    requestAnimationFrame(() => textareaRef.current?.focus());
  };
  // 目前輸入框對應的 session：送出失敗回來時用它判斷「使用者是不是已經切走了」。
  const draftKeyRef = useRef(draftKey);
  draftKeyRef.current = draftKey;
  const fileRef = useRef<HTMLInputElement>(null);
  const composingRef = useRef(false);
  const submittingRef = useRef(false);
  const lastSubmitAtRef = useRef(0);
  const wasBusyRef = useRef(busy);
  const dispatchingSessionsRef = useRef(new Set<string>());
  const [dispatchTick, setDispatchTick] = useState(0);
  const onSubmitRef = useRef(onSubmit);
  onSubmitRef.current = onSubmit;
  const submitRef = useRef<HTMLButtonElement>(null);
  const [launchPhase, setLaunchPhase] = useState<LaunchPhase>("idle");
  const launchTimersRef = useRef<number[]>([]);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const receiptTimersRef = useRef<number[]>([]);
  // 外部預填時輸入框閃一下邊框；a/b 交替才能讓同名動畫每次都重播。
  const [prefillTick, setPrefillTick] = useState(0);
  const appliedInjectRef = useRef(0);
  useEffect(() => () => {
    for (const timer of [...launchTimersRef.current, ...receiptTimersRef.current]) window.clearTimeout(timer);
  }, []);

  function clearLaunchTimers() {
    for (const timer of launchTimersRef.current) window.clearTimeout(timer);
    launchTimersRef.current = [];
  }
  function laterLaunch(ms: number, phase: LaunchPhase) {
    launchTimersRef.current.push(window.setTimeout(() => setLaunchPhase(phase), ms));
  }
  /** 起飛：送出那一瞬間就播，不等伺服器。回傳起飛時間，讓結果回來時算還要等多久。 */
  function beginLaunch(): number {
    clearLaunchTimers();
    setLaunchPhase("launch");
    return Date.now();
  }
  /** 結果回來：成功 → 打勾 → 回原狀；失敗 → 紙飛機折返 → 回原狀（草稿已放回、錯誤訊息自己會出現）。 */
  function finishLaunch(startedAt: number, ok: boolean) {
    const wait = Math.max(0, LAUNCH_MIN_MS - (Date.now() - startedAt));
    if (!ok) {
      laterLaunch(wait, "return");
      laterLaunch(wait + LAUNCH_RETURN_MS, "settle");
      laterLaunch(wait + LAUNCH_RETURN_MS + LAUNCH_SETTLE_MS, "idle");
      return;
    }
    laterLaunch(wait, "done");
    laterLaunch(wait + LAUNCH_DONE_MS, "settle");
    laterLaunch(wait + LAUNCH_DONE_MS + LAUNCH_SETTLE_MS, "idle");
  }
  function launchOrigin(): ClientPoint {
    const rect = submitRef.current?.getBoundingClientRect();
    return rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : { x: window.innerWidth / 2, y: window.innerHeight - 40 };
  }
  function showReceipt(target: LaunchTarget, queued: boolean) {
    for (const timer of receiptTimersRef.current) window.clearTimeout(timer);
    const key = Date.now();
    setReceipt({ key, workerId: target.id, name: target.name, queued, leaving: false });
    receiptTimersRef.current = [
      window.setTimeout(() => setReceipt((current) => current?.key === key ? { ...current, leaving: true } : current), RECEIPT_MS),
      window.setTimeout(() => setReceipt((current) => current?.key === key ? null : current), RECEIPT_MS + 140),
    ];
  }

  const { dragActive } = useGlobalFileDrop({
    enabled: globalDrop && dock,
    onFiles: (files) => void attachFiles(files),
  });

  useEffect(() => {
    setFailedFiles([]);
  }, [draftKey]);

  // 外部預填（拖到 NPC 身上／指令面板「對某人下指令」）：等輸入框切到目標 NPC 那份
  // 草稿、附件也還原完，才把文字接在草稿後面、檔案加成附件，然後聚焦。不送出。
  useEffect(() => {
    if (!inject || inject.seq <= appliedInjectRef.current) return;
    if (inject.sessionKey !== draftKey || switchingSession || disabled) return;
    appliedInjectRef.current = inject.seq;
    onInjectApplied?.(inject.seq);
    const text = inject.text.trim();
    if (text) setDraftValue((current) => current.trim() ? `${current.replace(/\s+$/, "")}\n${text}` : text);
    if (inject.files.length > 0) void attachFiles(inject.files);
    setPrefillTick((tick) => tick + 1);
    // 觸控裝置只預填、不聚焦：邊框閃一下就知道字填進來了，鍵盤等使用者點了才出來。
    if (shouldAutoFocusComposer()) requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      textarea.focus();
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inject, draftKey, switchingSession, disabled]);

  useEffect(() => {
    if (palette?.open) focusTextarea(false);
  }, [palette?.open]);

  useEffect(() => {
    if (focusRequest <= 0 || disabled || !shouldAutoFocusComposer()) return;
    const frame = requestAnimationFrame(() => textareaRef.current?.focus());
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRequest, draftKey, disabled]);

  useEffect(() => {
    if (wasBusyRef.current && !busy && !disabled) focusTextarea();
    wasBusyRef.current = busy;
  }, [busy, disabled]);

  // Auto-dispatch the next queued command once the worker returns to idle.
  // server 佇列模式下由 server 自己 drain，前端不送（否則會重複送）。
  useEffect(() => {
    if (useServerQueue || !queueEnabled || switchingSession || busy || disabled || queued.length === 0 || dispatchingSessionsRef.current.has(draftKey)) return;
    const next = queued[0];
    const owner = ownerRef.current;
    const ownerKey = draftKey;
    dispatchingSessionsRef.current.add(owner);
    setQueued((commands) => commands.slice(1));
    void onSubmitRef.current({ text: next.text, images: next.images.map(imagePayload), documents: next.documents.map(documentPayload), clientMessageId: next.clientMessageId, idempotencyKey: next.idempotencyKey })
      .catch((cause: unknown) => cause instanceof Error ? cause.message : t("排隊訊息送出失敗"))
      .then((result) => {
        const message = typeof result === "string" && result ? result : null;
        if (message) { restoreFailedSubmission(owner, ownerKey, next.text, next.images, next.documents, message); return; }
        if (ownerRef.current !== owner) updateCachedSession(owner, (session) => ({ ...session, error: null }));
      })
      .finally(() => {
        dispatchingSessionsRef.current.delete(owner);
        setDispatchTick((tick) => tick + 1);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queueEnabled, busy, disabled, queued, draftKey, switchingSession, dispatchTick]);

  // v2.5.0 以前排在瀏覽器本機（IndexedDB）的待送訊息：改走 server 佇列後畫面與 drain 都只看 server，
  // 這批還原回來會永遠卡著——看不到、送不出也刪不掉。放回輸入框（原文＋附件）並提示，由使用者決定
  // 送出或刪掉，本機那份隨即清掉。不直接搬進 server 佇列：升級後它們就一直看不到，使用者可能早已
  // 重送過，而 server 佇列在 NPC 閒著時會立刻開跑。
  useEffect(() => {
    if (!useServerQueue || switchingSession || queued.length === 0) return;
    const restored = legacyQueueRestore(queued);
    setQueued([]);
    setDraftValue((current) => restoreFailedDraft(current, restored.text));
    setImages((current) => mergeComposerItems(restored.images, current));
    setDocuments((current) => mergeComposerItems(restored.documents, current));
    setError(t("舊版留在這台裝置、還沒送出的 {n} 則排隊訊息已放回輸入框，確認後再送出", { n: queued.length }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [useServerQueue, switchingSession, queued]);

  // 影片解析結果（影格＋字幕）套進輸入框：影格當圖片、字幕當隱形隨附檔。上傳檔與貼連結共用。
  // label 是顯示用來源名（檔名或影片標題/連結），讓多張影格在輸入框收合成一個影片晶片。
  async function applyVideoResult(data: VideoAnalysisResult, label: string, owner: string) {
    const frames: ComposerImage[] = (data.images ?? []).map((frame, index) => ({
      id: `vid-${Date.now()}-${index}`,
      name: frame.name,
      mimeType: frame.mimeType as ComposerImage["mimeType"],
      dataBase64: frame.dataBase64,
      previewUrl: `data:${frame.mimeType};base64,${frame.dataBase64}`,
      size: Math.floor(frame.dataBase64.length * 0.75),
      videoName: label,
    }));
    const transcript = String(data.transcript ?? "").trim();
    // 字幕不再塞進「可編輯草稿」洗版（原本會秀一大坨「【影片音訊字幕】…」）。改成隱形隨附的
    // 字幕檔：你只看到影格縮圖，送出時 Claude 一樣讀得到音訊內容——體感更接近「直接看影片」。
    const transcriptDoc = transcript
      ? await readComposerDocument(new File([transcript], t("影片字幕.txt"), { type: "text/plain" }))
      : null;
    if (persistExtras && ownerRef.current !== owner) {
      updateCachedSession(owner, (session) => ({
        ...session,
        images: [...session.images, ...frames].slice(0, MAX_IMAGES),
        documents: transcriptDoc ? [...session.documents, transcriptDoc].slice(0, MAX_DOCUMENTS) : session.documents,
        error: null,
      }));
    } else {
      setImages((current) => [...current, ...frames].slice(0, MAX_IMAGES));
      if (transcriptDoc) setDocuments((current) => [...current, transcriptDoc].slice(0, MAX_DOCUMENTS));
      if (!transcript && data.transcriptError) setError(String(data.transcriptError));
      else setError(null);
      focusTextarea();
    }
  }

  // 影片解析失敗的錯誤顯示在它那位 NPC 的輸入框：使用者已切走就記進那位的快取，不灌進眼前這個。
  function reportVideoError(owner: string, message: string) {
    if (persistExtras && ownerRef.current !== owner) {
      updateCachedSession(owner, (session) => ({ ...session, error: message }));
      return;
    }
    setError(message);
  }

  // 影片：Claude 不吃影片，交給 server 抽關鍵影格＋whisper 轉音訊字幕，回來的影格當圖片、
  // 字幕接進草稿。逐個處理、顯示「處理影片中…」。影格受圖片上限（MAX_IMAGES）截斷。
  async function processVideos(videoFiles: File[], owner: string) {
    const job = beginVideoJob(owner, videoFiles.map((file) => file.name));
    let failed = false;
    try {
    for (const file of videoFiles) {
      if (file.size > MAX_VIDEO_BYTES) { failed = true; reportVideoError(owner, t("影片不可超過 {mb} MB", { mb: Math.round(MAX_VIDEO_BYTES / 1024 / 1024) })); continue; }
      try {
        const form = new FormData();
        form.append("video", file, file.name);
        const response = await fetch("/api/video/process", { method: "POST", body: form });
        if (!response.ok) {
          const detail = await response.json().catch(() => null);
          throw new Error(detail?.error || t("影片處理失敗（{status}）", { status: response.status }));
        }
        const data = await response.json() as VideoAnalysisResult;
        await applyVideoResult(data, file.name, owner);
      } catch (videoError) {
        failed = true;
        reportVideoError(owner, videoError instanceof Error ? videoError.message : t("影片處理失敗"));
      }
    }
    } finally {
      endVideoJob(job, owner, failed);
    }
  }

  // 貼連結看影片：把公開影片連結送到 server（yt-dlp 下載 → 同一條抽影格＋字幕管線）。
  // 顯示一個「解析中」佔位晶片；完成後影格＋字幕就跟上傳影片一樣掛進輸入框。
  async function processVideoLink(url: string) {
    const owner = ownerRef.current;
    const label = t("連結影片");
    const job = beginVideoJob(owner, [label]);
    let failed = false;
    try {
      const response = await fetch("/api/video/from-link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      if (!response.ok) {
        const detail = await response.json().catch(() => null);
        throw new Error(detail?.error || t("影片下載失敗（{status}）", { status: response.status }));
      }
      const data = await response.json() as VideoAnalysisResult;
      await applyVideoResult(data, label, owner);
    } catch (linkError) {
      failed = true;
      reportVideoError(owner, linkError instanceof Error ? linkError.message : t("影片下載失敗"));
    } finally {
      endVideoJob(job, owner, failed);
    }
  }

  async function attachFiles(files: File[]) {
    const owner = ownerRef.current;
    const videoFiles = files.filter(isVideoFile);
    const imageFiles = files.filter(isImageFile);
    const documentFiles = files.filter((file) => !isImageFile(file) && !isVideoFile(file));
    if (videoFiles.length > 0) void processVideos(videoFiles, owner);
    if (imageFiles.length === 0 && documentFiles.length === 0) return;
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
      focusTextarea();
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
    focusTextarea(false);
  }

  /** 送出（或排隊）失敗：把原文、附件放回它原本那位 NPC 的輸入框。使用者等待期間
   *  若已切到別的 NPC，就併回那位 NPC 存起來的草稿／附件快取，不灌進眼前這個輸入框。 */
  function restoreFailedSubmission(owner: string, ownerKey: string, text: string, failedImages: ComposerImage[], failedDocuments: ComposerDocument[], message: string) {
    if (ownerRef.current !== owner || draftKeyRef.current !== ownerKey) {
      writeComposerDraft(ownerKey, restoreFailedDraft(readStoredDraft(ownerKey), text));
      if (persistExtras) {
        updateCachedSession(owner, (session) => ({
          ...session,
          error: message,
          images: mergeFailed(failedImages, session.images, MAX_IMAGES),
          documents: mergeFailed(failedDocuments, session.documents, MAX_DOCUMENTS),
        }));
      }
      return;
    }
    setError(message);
    setDraftValue((current) => restoreFailedDraft(current, text));
    setImages((current) => mergeFailed(failedImages, current, MAX_IMAGES));
    setDocuments((current) => mergeFailed(failedDocuments, current, MAX_DOCUMENTS));
  }

  async function submit(source: ComposerSubmitSource = "button") {
    if (disabled || switchingSession || submittingRef.current) return;
    if (palette?.open) return;
    const text = draftValue.trim();
    const empty = !text && images.length === 0 && documents.length === 0;
    // 影片還在解析：不要現在送（會漏掉影格/字幕）。記下是哪位 NPC 的，解析完由 effect 自動送出。
    // NPC 忙碌、輸入框空白時按的「中止」鈕不在此列——照常往下走去中止。
    if (deferSubmitForVideo(videoProcessing, source, queueEnabled && busy && empty)) { setPendingVideoSend({ owner: draftKey, failed: false }); return; }
    if (queueEnabled && busy) {
      if (empty) {
        // 空白送出＝中止任務，只認「中止」鈕：空白 Enter（太快連按兩下、或手指只是碰到
        // Enter）一律不動作，不會把正在跑的任務砍掉。按鈕剛送出後的短時間內也忽略。
        // 中止時一併取消等著影片解析完的自動送出。
        if (emptySubmitAction(source, Date.now() - lastSubmitAtRef.current, INTERRUPT_GUARD_MS) === "interrupt") {
          setPendingVideoSend(null);
          onInterrupt?.();
        }
        return;
      }
      const queueLength = useServerQueue ? serverQueueItems.length : queued.length;
      if (queueLength >= MAX_QUEUED_COMMANDS) {
        setError(t("等待佇列最多 {max} 項", { max: MAX_QUEUED_COMMANDS }));
        return;
      }
      lastSubmitAtRef.current = Date.now();
      if (useServerQueue) {
        // 排到 server 佇列：手機/電腦共用，該 NPC 一空下來 server 自己送。
        const submission: CommandSubmission = { text, images: images.map(imagePayload), documents: documents.map(documentPayload), ...newClientMessageIdentity() };
        const owner = ownerRef.current;
        const ownerKey = draftKey;
        const queuedImages = images;
        const queuedDocuments = documents;
        setDraftValue("");
        setImages([]);
        setDocuments([]);
        setError(null);
        const queuedFor = launchTarget;
        // 排隊失敗（回錯誤或請求本身丟例外）以前會直接吃掉草稿；現在原文與附件一律放回。
        void onEnqueue!(submission)
          .catch((cause: unknown) => cause instanceof Error ? cause.message : t("排隊訊息送出失敗"))
          .then((message) => {
            if (message) { restoreFailedSubmission(owner, ownerKey, text, queuedImages, queuedDocuments, message); return; }
            if (queuedFor) showReceipt(queuedFor, true);
          });
        focusTextarea();
        return;
      }
      const command: QueuedCommand = { id: newQueueId(), text, images, documents, ...newClientMessageIdentity() };
      setDraftValue("");
      setImages([]);
      setDocuments([]);
      setError(null);
      setQueued((commands) => [...commands, command]);
      if (launchTarget) showReceipt(launchTarget, true);
      focusTextarea();
      return;
    }
    if (working) return;
    if (empty) return;
    submittingRef.current = true;
    lastSubmitAtRef.current = Date.now();
    const owner = ownerRef.current;
    const ownerKey = draftKey;
    const submittedImages = images;
    const submittedDocuments = documents;
    const identity = newClientMessageIdentity();
    const submission: CommandSubmission = { text, images: images.map(imagePayload), documents: documents.map(documentPayload), ...identity };
    // 送出動態：起飛點與對象在「按下的這一刻」就記下來——等回應回來時使用者可能
    // 已經切到別的 NPC，紙飛機仍要飛向這則訊息真正的收件人。
    const launchedFor = launchTarget;
    const launchFrom = launchOrigin();
    const launchStartedAt = beginLaunch();
    setDraftValue("");
    setImages([]);
    setDocuments([]);
    setError(null);
    palette?.onOpenChange(false);
    focusTextarea();
    const result = await onSubmit(submission).catch((cause: unknown) => cause instanceof Error ? cause.message : t("訊息送出失敗"));
    submittingRef.current = false;
    const message = typeof result === "string" && result ? result : null;
    // 真實送出成功（onSubmit 沒回錯誤）才打勾、亮回執、通知場景放紙飛機；失敗則紙飛機折返。
    finishLaunch(launchStartedAt, !message);
    if (!message && launchedFor) {
      showReceipt(launchedFor, false);
      onLaunch?.({ workerId: launchedFor.id, from: launchFrom, text });
    }
    if (message) {
      restoreFailedSubmission(owner, ownerKey, text, submittedImages, submittedDocuments, message);
      return;
    }
    if (persistExtras && ownerRef.current !== owner) {
      updateCachedSession(owner, (session) => ({ ...session, error: null }));
      return;
    }
    setError(null);
  }

  // 影片解析完成後，若使用者稍早按過送出（pendingVideoSend），就用當前(已含影格/字幕)的
  // 狀態自動送出。放在 effect 裡，才讀得到解析後最新的 images/documents（避免 stale closure）。
  // 只送給按下送出的那位 NPC：已切到別人就取消；有影片解析失敗也取消——草稿與錯誤都留著，
  // 不把文字單獨送出去、也不把錯誤洗掉。
  const videoSendAction = videoAutoSendAction(pendingVideoSend, draftKey, videoProcessing);
  const awaitingVideoSend = videoSendAction === "wait";
  useEffect(() => {
    if (videoSendAction === "none" || videoSendAction === "wait") return;
    setPendingVideoSend(null);
    if (videoSendAction === "send") void submit("auto");
    // submit 是每次 render 重建的函式；此處刻意只依賴決策結果，觸發時會捕捉到最新 submit。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoSendAction]);

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
        else if (action === "submit") void submit("enter");
        return;
      }
      if (shouldSubmitComposerKey({ key: event.key, shiftKey: event.shiftKey, isComposing, repeat: event.repeat })) {
        event.preventDefault();
        void submit("enter");
      }
    }
  }

  const hasContent = Boolean(draftValue.trim() || images.length || documents.length);
  const hasAttachments = images.length > 0 || documents.length > 0 || processingVideoNames.length > 0;
  const canInterrupt = queueEnabled && busy && !hasContent;
  const submitDisabled = disabled || (working && !queueEnabled) || (!hasContent && !canInterrupt);
  const submitLabelToShow = canInterrupt ? t("中止") : queueEnabled && busy && hasContent ? t("排隊") : working ? busyLabel : submitLabel;
  // 輸入框旁的狀態列（只在有送出對象的 dock 輸入框）：需要你／工作中／待命。
  const status = composerStatus({ busy, working, needsAttention });
  const statusLine = dock && launchTarget ? <span className="composer-status" data-state={status} role="status" aria-live="polite" title={t("{name} 目前狀態", { name: launchTarget.name })}>
    <i className="composer-status__mark" aria-hidden="true" />
    <span key={status} className="composer-status__label">{status === "attention" ? t("需要你") : status === "working" ? t("工作中") : t("待命")}</span>
  </span> : null;

  // 收合影片影格：同一支影片的多張關鍵影格併成「一個」影片晶片（cover=第一格、count=張數），
  // 其餘圖片各自一個。這樣影片解析完不會冒出一坨縮圖，只看到一個「影片 · N 格」。
  const imageChipGroups = (() => {
    const groups: Array<{ key: string; cover: ComposerImage; videoName?: string; count: number }> = [];
    const seen = new Set<string>();
    for (const image of images) {
      if (image.videoName) {
        if (seen.has(image.videoName)) continue;
        seen.add(image.videoName);
        groups.push({ key: `vid:${image.videoName}`, cover: image, videoName: image.videoName, count: images.filter((item) => item.videoName === image.videoName).length });
      } else {
        groups.push({ key: image.id, cover: image, count: 1 });
      }
    }
    return groups;
  })();
  // 貼連結看影片：輸入框內偵測到影片平台網址 → 冒一顆按鈕，一鍵下載＋抽影格＋字幕。
  // 已經抓過（有「連結影片」附件）或正在解析時就不再提示，避免重複洗版。
  const linkVideoLabel = t("連結影片");
  const detectedVideoUrl = detectVideoUrl(draftValue);
  const videoLinkPrompt = detectedVideoUrl && !videoProcessing && !images.some((image) => image.videoName === linkVideoLabel) ? (
    <button type="button" className="composer-video-link" title={detectedVideoUrl} onClick={() => void processVideoLink(detectedVideoUrl)}>
      <Icon name="film" /> {t("解析這支影片（抓畫面＋字幕）")}
    </button>
  ) : null;
  const attachmentsBlock = hasAttachments && (
    dock ? <div className="command-composer__attachments" aria-label={t("待傳送附件")}>
      {imageChipGroups.map((group, index) => group.videoName
        ? <div className="command-composer__attachment command-composer__attachment--video" key={group.key} title={group.videoName}>
          <img src={group.cover.previewUrl} alt={group.videoName} />
          <span><Icon name="film" /> {t("{n} 格", { n: group.count })}</span>
          <button type="button" aria-label={t("移除影片")} onClick={() => setImages((current) => current.filter((item) => item.videoName !== group.videoName))}>×</button>
        </div>
        : <div className="command-composer__attachment" key={group.key}>
          <img src={group.cover.previewUrl} alt={t("圖片 {n}：{name}", { n: index + 1, name: group.cover.name })} />
          <span>IMG {index + 1}</span>
          <button type="button" aria-label={t("移除圖片 {n}", { n: index + 1 })} onClick={() => setImages((current) => current.filter((item) => item.id !== group.cover.id))}>×</button>
        </div>)}
      {processingVideoNames.map((name) => <div className="command-composer__attachment command-composer__attachment--video command-composer__attachment--processing" key={`proc:${name}`} title={name}>
        <span className="command-composer__attachment-proc" aria-hidden="true"><Icon name="film" /></span>
        <span>{t("解析中")}</span>
      </div>)}
      {documents.map((document, index) => <div className="command-composer__attachment command-composer__attachment--document" key={document.id} title={document.name}>
        <strong>{documentBadge(document.name)}</strong>
        <em>{document.name}</em>
        <span>FILE {index + 1}</span>
        <button type="button" aria-label={t("移除文件 {n}", { n: index + 1 })} onClick={() => setDocuments((current) => current.filter((item) => item.id !== document.id))}>×</button>
      </div>)}
    </div> : <div className="task-composer__attachments">
      {imageChipGroups.map((group) => group.videoName
        ? <div key={group.key} className="task-composer__attachment task-composer__attachment--video" title={group.videoName}><img src={group.cover.previewUrl} alt={group.videoName} /><span><Icon name="film" /> {t("影片 · {n} 格", { n: group.count })}</span><button type="button" aria-label={t("移除影片")} onClick={() => setImages((current) => current.filter((item) => item.videoName !== group.videoName))}>×</button></div>
        : <div key={group.key} className="task-composer__attachment"><img src={group.cover.previewUrl} alt={group.cover.name} /><span>{group.cover.name}</span><button type="button" aria-label={t("移除 {name}", { name: group.cover.name })} onClick={() => setImages((current) => current.filter((item) => item.id !== group.cover.id))}>×</button></div>)}
      {processingVideoNames.map((name) => <div key={`proc:${name}`} className="task-composer__attachment task-composer__attachment--video task-composer__attachment--processing" title={name}><span className="task-composer__attachment-proc" aria-hidden="true"><Icon name="film" /></span><span>{t("解析中…")}</span></div>)}
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
    autoFocus={dock && focusRequest > 0 && shouldAutoFocusComposer()}
    value={draftValue}
    rows={1}
    spellCheck={false}
    disabled={disabled || (working && !queueEnabled)}
    aria-busy={Boolean(busy || working)}
    placeholder={placeholder}
    aria-label={dock ? t("輸入 Agent 指令") : undefined}
    // Line-height/padding here must match the .command-composer > textarea /
    // .task-composer__row textarea CSS rules — otherwise the computed inline
    // height under- or over-shoots the CSS max-height cap for that variant.
    style={{ height: dock ? composerTextareaHeight(draftValue, 18.85, 6) : composerTextareaHeight(draftValue, 22, 16) }}
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
      <form ref={formRef} className={`command-composer ${focusMode ? "command-composer--focus" : ""} ${hasAttachments ? "command-composer--attachments" : ""}`} data-session-key={draftKey} data-busy={busy || working ? "true" : undefined} data-prefill={prefillTick > 0 ? (prefillTick % 2 ? "a" : "b") : undefined} data-dropping={dragActive && globalDrop ? "true" : undefined} data-file-drop-owner="task-composer" aria-label={focusMode ? t("專業模式指令輸入") : undefined} onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        {attachmentsBlock}
        <div className="command-composer__toolbar">
          {palette && <button className="command-composer__library" type="button" onClick={() => palette.onOpenChange(!palette.open)} aria-expanded={palette.open} title={t("斜線指令面板（輸入 / 也能打開）")}>
            ⌘ <span>{palette.provider === "claude" ? "CLAUDE" : "CODEX"}</span>
          </button>}
          {fileInput}
          <button className="command-composer__attach" type="button" onClick={() => fileRef.current?.click()} title={t("附加圖片或文件")} aria-label={t("附加圖片或文件")}>＋</button>
          {voiceEnabled && !disabled && <VoiceInputButton onTranscript={(text) => {
            setDraftValue((current) => insertVoiceTranscript(current, text));
            focusTextarea();
          }} />}
          {toolbar}
        </div>
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
        {leading}
        {textareaField}
        {videoLinkPrompt}
        {videoProcessing && <span className="command-composer__video-processing" role="status">{awaitingVideoSend ? <><Icon name="film" /> {t("影片解析中…完成後自動送出")}</> : t("處理影片中…（抽畫面＋音訊轉文字）")}</span>}
        {error && <span className="command-composer__error" role="alert">{error}</span>}
        {persistenceWarning && <span className="command-composer__error command-composer__error--storage" role="alert">{persistenceWarning}</span>}
        {statusLine}
        {queueEnabled && (useServerQueue ? serverQueueItems.length > 0 : queued.length > 0) && <QueuePanel
          waiting={busy || working}
          items={useServerQueue
            ? serverQueueItems.map((item) => ({ id: item.id, text: item.message, imageCount: item.images.length, documentCount: item.documents.length }))
            : queued.map((command) => ({ id: command.id, text: command.text, imageCount: command.images.length, documentCount: command.documents.length }))}
          restoringExtras={useServerQueue ? false : restoringExtras}
          extrasSaved={useServerQueue ? true : extrasSaved}
          onEdit={(index) => {
            if (useServerQueue) {
              // server 佇列：載入編輯＝把該項從 server 移除、文字放回輸入框（附件不還原）。
              const target = serverQueueItems[index];
              if (!target) return;
              onRemoveQueued?.(target.id);
              setDraftValue(target.message);
              setError(null);
              focusTextarea(false);
              return;
            }
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
            focusTextarea(false);
          }}
          onMove={(index, offset) => {
            if (useServerQueue) { onReorderQueued?.(moveQueuedItem(serverQueueItems.map((item) => item.id), index, offset)); return; }
            setQueued((commands) => moveQueuedItem(commands, index, offset));
          }}
          onReorder={(from, to) => {
            if (useServerQueue) { onReorderQueued?.(reorderQueuedItem(serverQueueItems.map((item) => item.id), from, to)); return; }
            setQueued((commands) => reorderQueuedItem(commands, from, to));
          }}
          onCancel={(id) => {
            if (useServerQueue) { onRemoveQueued?.(id); return; }
            setQueued((commands) => commands.filter((item) => item.id !== id));
          }}
        />}
        {receipt && <button
          key={receipt.key}
          type="button"
          className={`command-composer__receipt${receipt.queued ? " command-composer__receipt--queued" : ""}`}
          data-leaving={receipt.leaving ? "true" : undefined}
          style={{ "--receipt-ms": `${RECEIPT_MS}ms` } as React.CSSProperties}
          title={t("跳到 {name}", { name: receipt.name })}
          onClick={() => { onReceiptOpen?.(receipt.workerId); setReceipt(null); }}
        >
          <span className="command-composer__receipt-plane" aria-hidden="true"><Icon name={receipt.queued ? "clock" : "send"} /></span>
          <span role="status">{receipt.queued ? t("已排入 {name} 的佇列", { name: receipt.name }) : t("已交給 {name}", { name: receipt.name })}</span>
          <small aria-hidden="true">→</small>
        </button>}
        <button ref={submitRef} className={`command-composer__submit ${canInterrupt ? "command-composer__submit--stop" : ""}`} type="submit" disabled={submitDisabled} data-launch={launchPhase === "idle" ? undefined : launchPhase}>
          <span className="command-composer__submit-label">{submitLabelToShow}</span>
          <span className="command-composer__submit-fx" aria-hidden="true"><Icon name="send" /></span>
          <span className="command-composer__submit-ok" aria-hidden="true"><Icon name="check" /></span>
        </button>
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
    {videoLinkPrompt && <div className="task-composer__video-link-row">{videoLinkPrompt}</div>}
    {videoProcessing && <div className="task-composer__error" role="status">{awaitingVideoSend ? <><Icon name="film" /> {t("影片解析中…完成後自動送出")}</> : t("處理影片中…（抽畫面＋音訊轉文字）")}</div>}
    {error && <div className="task-composer__error" role="alert">{error}{failedFiles.length > 0 && <button type="button" onClick={() => void attachFiles(failedFiles)}>{t("重試附件")}</button>}</div>}
  </form>;
}

type QueueDisplayItem = { id: string; text: string; imageCount: number; documentCount: number };

function QueuePanel({ items, waiting = false, restoringExtras, extrasSaved, onEdit, onMove, onReorder, onCancel }: {
  items: QueueDisplayItem[];
  /** NPC 還在忙：排隊中的訊息正在等，晶片上的堆疊條慢慢「往前推」。 */
  waiting?: boolean;
  restoringExtras: boolean;
  extrasSaved: boolean;
  onEdit(index: number): void;
  onMove(index: number, offset: -1 | 1): void;
  onReorder(from: number, to: number): void;
  onCancel(id: string): void;
}) {
  const [open, setOpen] = useState(false);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  // 新排進一則：晶片輕輕落定一下（a/b 交替，連續排隊也會重播）。數量變少（送出／取消）不動。
  const arrivalRef = useRef({ count: items.length, tick: 0 });
  if (items.length > arrivalRef.current.count) arrivalRef.current.tick += 1;
  arrivalRef.current.count = items.length;
  const arrivalTick = arrivalRef.current.tick;
  return <>
    <button type="button" className="command-composer__queue" aria-expanded={open} data-waiting={waiting ? "true" : undefined} data-arrive={arrivalTick > 0 ? (arrivalTick % 2 ? "a" : "b") : undefined} onClick={() => setOpen((value) => !value)}>
      <span className="command-composer__queue-stack" aria-hidden="true">{Array.from({ length: Math.min(items.length, 3) }, (_, index) => <i key={index} />)}</span>
      {/* NPC 手上還有一件在跑：明講「排隊中、等它做完」，不然手機上看起來像訊息卡住沒送到。 */}
      <span>{waiting ? t("排隊 {count}·等手上這件", { count: items.length }) : t("等待 {count}", { count: items.length })}</span>
    </button>
    {open && <div className="command-queue" aria-label={t("待送訊息佇列")}>
      <header><div><span>UP NEXT</span><strong>{t("待送訊息")} {restoringExtras ? t("· 復原中…") : extrasSaved ? t("· 已保存") : t("· 保存中…")}</strong></div><button type="button" aria-label={t("關閉待送訊息")} onClick={() => setOpen(false)}>×</button></header>
      <ol>{items.map((command, index) => <li key={command.id} className={dragIndex === index ? "command-queue__item--dragging" : ""} onDragOver={(event) => { if (dragIndex !== null) event.preventDefault(); }} onDrop={(event) => {
        if (dragIndex === null) return;
        event.preventDefault();
        onReorder(dragIndex, index);
        setDragIndex(null);
      }}>
        <span className="command-queue__drag" draggable title={t("拖曳調整順序")} aria-hidden="true" onDragStart={(event) => { event.dataTransfer.effectAllowed = "move"; setDragIndex(index); }} onDragEnd={() => setDragIndex(null)}>⠿</span>
        <button type="button" className="command-queue__edit" onClick={() => { onEdit(index); setOpen(false); }} title={t("載入編輯")}>
          <strong>{command.text || t("只有附件的訊息")}</strong>
          <small>{command.imageCount > 0 ? t("{n} 張圖片", { n: command.imageCount }) : ""}{command.imageCount > 0 && command.documentCount > 0 ? " · " : ""}{command.documentCount > 0 ? t("{n} 份文件", { n: command.documentCount }) : ""}</small>
        </button>
        <div className="command-queue__actions">
          <button type="button" disabled={index === 0} aria-label={t("往前移")} onClick={() => onMove(index, -1)}>↑</button>
          <button type="button" disabled={index === items.length - 1} aria-label={t("往後移")} onClick={() => onMove(index, 1)}>↓</button>
          <button type="button" aria-label={t("取消待送訊息")} onClick={() => onCancel(command.id)}>×</button>
        </div>
      </li>)}</ol>
      <footer>{t("點選內容可載入編輯；目前草稿會與該項目交換。")}</footer>
    </div>}
  </>;
}
