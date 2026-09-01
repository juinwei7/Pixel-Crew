import { useEffect, useRef, useState } from "react";
import { apiAssetUrl, apiRequest } from "../api";
import { encodeWavBlob, hasAudibleSpeech, isLocalVoiceInputContext, resampleToMono16k } from "../voiceRecording";
import { t } from "../i18n";

export type VoiceModelStatus = "not_downloaded" | "downloading" | "ready" | "failed";
export type VoiceModelState = {
  status: VoiceModelStatus;
  bytesDownloaded: number;
  totalBytes: number;
  error: string | null;
  name: string;
  fileName: string;
};
export type VoiceEngineInstallStatus = "not_supported" | "not_installed" | "downloading" | "ready" | "failed";
export type VoiceEngineInstallState = {
  status: VoiceEngineInstallStatus;
  supported: boolean;
  name: string;
  bytesDownloaded: number;
  totalBytes: number;
  error: string | null;
};
export type VoiceStatusResponse = { engineAvailable: boolean; engineInstaller: VoiceEngineInstallState; model: VoiceModelState };

export type VoiceInputPhase =
  | "idle"
  | "checking"
  | "confirm-engine-install"
  | "installing-engine"
  | "confirm-download"
  | "downloading"
  | "requesting-permission"
  | "recording"
  | "transcribing"
  | "error";

// 30 秒、16kHz、16-bit、單聲道 WAV ≈ 0.96 MB；伺服器端上限是 4 MiB（見
// server/src/voice/voiceRoutes.ts），這裡在到達前就自動停止，避免使用者忘記按停止
// 結果整段被伺服器拒收。
const MAX_RECORDING_MS = 120_000;
const MODEL_POLL_MS = 700;

export function useVoiceInput(): {
  phase: VoiceInputPhase;
  error: string | null;
  elapsedMs: number;
  model: VoiceModelState | null;
  engineInstaller: VoiceEngineInstallState | null;
  supported: boolean;
  requestStart(): Promise<void>;
  confirmEngineInstall(): void;
  confirmDownload(): void;
  stopAndTranscribe(): Promise<string | null>;
  cancel(): void;
} {
  const [phase, setPhase] = useState<VoiceInputPhase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [model, setModel] = useState<VoiceModelState | null>(null);
  const [engineInstaller, setEngineInstaller] = useState<VoiceEngineInstallState | null>(null);

  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const elapsedTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const recordingStartedAtRef = useRef(0);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  const supported =
    typeof window !== "undefined" &&
    isLocalVoiceInputContext(window.location.hostname) &&
    typeof navigator !== "undefined" &&
    Boolean(navigator.mediaDevices?.getUserMedia) &&
    typeof MediaRecorder !== "undefined";

  useEffect(() => {
    // React 18 StrictMode 的開發模式會把 effect 跑一次「掛載→清理→再掛載」來抓
    // 漏清理的 bug；若只在清理時把 mountedRef 設成 false，這次雙重呼叫會讓它永遠
    // 卡在 false，後面每個 `if (!mountedRef.current) return;` 都會提前擋掉。掛載時
    // 明確設回 true 才對得上「這個元件現在是不是還活著」的真實語意。
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      stopElapsedTimer();
      clearPollTimer();
      releaseStream();
    };
  }, []);

  function stopElapsedTimer() {
    if (elapsedTimerRef.current) clearInterval(elapsedTimerRef.current);
    elapsedTimerRef.current = null;
  }

  function clearPollTimer() {
    if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    pollTimerRef.current = null;
  }

  function releaseStream() {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    recorderRef.current = null;
  }

  async function fetchStatus(): Promise<VoiceStatusResponse | null> {
    try {
      return await apiRequest<VoiceStatusResponse>("/api/voice/status");
    } catch {
      return null;
    }
  }

  function schedulePoll() {
    clearPollTimer();
    pollTimerRef.current = setTimeout(async () => {
      const status = await fetchStatus();
      if (!mountedRef.current || !status) return;
      setModel(status.model);
      setEngineInstaller(status.engineInstaller);
      if (status.engineInstaller.status === "downloading") {
        schedulePoll();
      } else if (status.engineInstaller.status === "ready" && status.engineAvailable) {
        setPhase(status.model.status === "ready" ? "idle" : "confirm-download");
      } else if (status.engineInstaller.status === "failed") {
        setPhase("error");
        setError(status.engineInstaller.error || t("語音轉寫引擎安裝失敗"));
      } else if (status.model.status === "downloading") {
        schedulePoll();
      } else if (status.model.status === "ready") {
        setPhase("idle");
      } else if (status.model.status === "failed") {
        setPhase("error");
        setError(status.model.error || t("模型下載失敗"));
      }
    }, MODEL_POLL_MS);
  }

  // 麥克風按鈕被按下：先確認模型狀態，未下載就停在確認畫面（不錄音），已就緒才真正要權限。
  async function requestStart(): Promise<void> {
    if (!supported) return;
    setError(null);
    setPhase("checking");
    const status = await fetchStatus();
    if (!mountedRef.current) return;
    if (!status || !status.engineAvailable) {
      setEngineInstaller(status?.engineInstaller ?? null);
      if (status?.engineInstaller.supported) {
        setPhase("confirm-engine-install");
      } else {
        setPhase("error");
        setError(t("找不到本機語音轉寫引擎"));
      }
      return;
    }
    setEngineInstaller(status.engineInstaller);
    setModel(status.model);
    if (status.model.status === "ready") {
      await beginRecording();
      return;
    }
    setPhase("confirm-download");
  }

  function confirmEngineInstall(): void {
    setPhase("installing-engine");
    void apiRequest<{ engineInstaller: VoiceEngineInstallState }>("/api/voice/engine/install", { method: "POST" })
      .then((result) => { if (mountedRef.current) setEngineInstaller(result.engineInstaller); })
      .catch((error) => {
        if (!mountedRef.current) return;
        setPhase("error");
        setError(error instanceof Error ? error.message : t("語音轉寫引擎安裝失敗"));
      });
    schedulePoll();
  }

  function confirmDownload(): void {
    setPhase("downloading");
    void apiRequest<{ model: VoiceModelState }>("/api/voice/model/download", { method: "POST" })
      .then((result) => { if (mountedRef.current) setModel(result.model); })
      .catch(() => { /* 下一次輪詢會反映失敗狀態 */ });
    schedulePoll();
  }

  async function beginRecording(): Promise<void> {
    setPhase("requesting-permission");
    try {
      // 關掉自動增益：AGC 會把安靜環境的背景雜訊自動放大到目標音量，讓
      // hasAudibleSpeech() 的音量門檻在真實麥克風上失去意義（純數位靜音檔測試
      // 測不出這個問題，因為那裡沒有 AGC 在運作）。關掉後錄到的是麥克風的原始
      // 音量，安靜就是安靜。
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { autoGainControl: false, noiseSuppression: true, echoCancellation: true },
      });
      if (!mountedRef.current) { stream.getTracks().forEach((track) => track.stop()); return; }
      streamRef.current = stream;
      chunksRef.current = [];
      const recorder = new MediaRecorder(stream);
      recorder.ondataavailable = (event) => { if (event.data.size > 0) chunksRef.current.push(event.data); };
      recorderRef.current = recorder;
      recorder.start();
      recordingStartedAtRef.current = Date.now();
      setElapsedMs(0);
      stopElapsedTimer();
      elapsedTimerRef.current = setInterval(() => {
        const elapsed = Date.now() - recordingStartedAtRef.current;
        setElapsedMs(elapsed);
        if (elapsed >= MAX_RECORDING_MS) void stopAndTranscribe();
      }, 200);
      setPhase("recording");
    } catch (cause) {
      const name = (cause as Error).name;
      setPhase("error");
      setError(name === "NotAllowedError" || name === "SecurityError"
        ? t("麥克風權限遭拒，請在瀏覽器或系統設定開啟後重試")
        : t("無法啟動麥克風，請重試"));
      releaseStream();
    }
  }

  async function stopAndTranscribe(): Promise<string | null> {
    const recorder = recorderRef.current;
    if (!recorder || phase !== "recording") return null;
    stopElapsedTimer();
    const audioBlob = await new Promise<Blob>((resolve) => {
      recorder.addEventListener("stop", () => resolve(new Blob(chunksRef.current, { type: recorder.mimeType })), { once: true });
      recorder.stop();
    });
    releaseStream();
    if (!mountedRef.current) return null;
    setPhase("transcribing");
    try {
      const mono16k = await decodeToMono16k(audioBlob);
      if (!mountedRef.current) return null;
      if (!hasAudibleSpeech(mono16k)) {
        // whisper 對靜音不會回傳空字串，而是幻覺出一段無關文字（見
        // voiceRecording.ts 的說明）；在送出前用音量擋掉，對應 spec §6「沒有
        // 偵測到語音」──顯示可重試提示，不讓幻覺文字混進聊天輸入框。
        setPhase("error");
        setError(t("沒有偵測到語音，可重試"));
        return null;
      }
      const wavBlob = encodeWavBlob(mono16k);
      const form = new FormData();
      form.append("audio", wavBlob, "recording.wav");
      const controller = new AbortController();
      abortRef.current = controller;
      const response = await fetch(apiAssetUrl("/api/voice/transcribe"), {
        method: "POST",
        body: form,
        signal: controller.signal,
      });
      const data = await response.json().catch(() => ({})) as { text?: string; error?: string };
      if (!mountedRef.current) return null;
      if (!response.ok) {
        setPhase("error");
        setError(data.error || t("語音轉寫失敗，請重試"));
        return null;
      }
      setPhase("idle");
      return data.text ?? null;
    } catch (cause) {
      if (!mountedRef.current) return null;
      if ((cause as Error).name === "AbortError") { setPhase("idle"); return null; }
      setPhase("error");
      setError(t("語音轉寫失敗，請重試"));
      return null;
    } finally {
      abortRef.current = null;
    }
  }

  function cancel(): void {
    stopElapsedTimer();
    clearPollTimer();
    if (abortRef.current) abortRef.current.abort();
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      recorder.addEventListener("stop", () => releaseStream(), { once: true });
      recorder.stop();
    } else {
      releaseStream();
    }
    chunksRef.current = [];
    setPhase("idle");
    setError(null);
  }

  return { phase, error, elapsedMs, model, engineInstaller, supported, requestStart, confirmEngineInstall, confirmDownload, stopAndTranscribe, cancel };
}

async function decodeToMono16k(recorded: Blob): Promise<Float32Array> {
  const arrayBuffer = await recorded.arrayBuffer();
  const AudioContextClass = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const audioContext = new AudioContextClass();
  try {
    const decoded = await audioContext.decodeAudioData(arrayBuffer);
    const channels = Array.from({ length: decoded.numberOfChannels }, (_, i) => decoded.getChannelData(i));
    return resampleToMono16k(channels, decoded.sampleRate);
  } finally {
    void audioContext.close();
  }
}
