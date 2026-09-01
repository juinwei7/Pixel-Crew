import { useVoiceInput } from "../hooks/useVoiceInput";
import { t } from "../i18n";

function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

type Props = {
  onTranscript(text: string): void;
};

export function VoiceInputButton({ onTranscript }: Props) {
  const voice = useVoiceInput();
  if (!voice.supported) return null;

  async function handleMicClick() {
    if (voice.phase === "idle" || voice.phase === "error") {
      await voice.requestStart();
      return;
    }
    if (voice.phase === "recording") {
      const text = await voice.stopAndTranscribe();
      if (text) onTranscript(text);
    }
  }

  const busy = voice.phase === "checking" || voice.phase === "requesting-permission" || voice.phase === "transcribing";

  return <span className="voice-input">
    <button
      type="button"
      className={`voice-input__mic${voice.phase === "recording" ? " voice-input__mic--recording" : ""}`}
      aria-label={voice.phase === "recording" ? t("停止錄音並轉成文字") : t("語音輸入")}
      title={voice.phase === "recording" ? t("停止錄音並轉成文字") : t("語音輸入")}
      disabled={busy || voice.phase === "downloading" || voice.phase === "confirm-download"}
      onClick={() => void handleMicClick()}
    >
      {voice.phase === "transcribing" ? "…" : voice.phase === "recording" ? "⏹" : "🎤"}
    </button>
    {voice.phase === "recording" && <>
      <span className="voice-input__timer" aria-live="polite">{formatElapsed(voice.elapsedMs)}</span>
      <button type="button" className="voice-input__cancel" aria-label={t("取消錄音")} title={t("取消錄音")} onClick={() => voice.cancel()}>×</button>
    </>}
    {voice.phase === "confirm-engine-install" && voice.engineInstaller && <div className="voice-input__panel" role="dialog" aria-label={t("安裝本機語音轉寫引擎")}>
      <strong>{t("安裝本機語音轉寫引擎")}</strong>
      <p>{t("語音輸入需要 {name}（約 {size}）。會從官方 GitHub 下載、驗證完整性，再只安裝到 Pixel Crew 的本機資料目錄；不會修改系統 PATH 或要求系統管理員權限。", { name: voice.engineInstaller.name, size: formatBytes(voice.engineInstaller.totalBytes) })}</p>
      <div className="voice-input__panel-actions">
        <button type="button" onClick={() => voice.confirmEngineInstall()}>{t("下載並安裝")}</button>
        <button type="button" onClick={() => voice.cancel()}>{t("取消")}</button>
      </div>
    </div>}
    {voice.phase === "installing-engine" && voice.engineInstaller && <div className="voice-input__panel" role="status" aria-live="polite">
      <strong>{t("正在安裝本機語音轉寫引擎…")}</strong>
      <div className="voice-input__progress"><div style={{ width: `${Math.min(100, Math.round((voice.engineInstaller.bytesDownloaded / Math.max(1, voice.engineInstaller.totalBytes)) * 100))}%` }} /></div>
    </div>}
    {voice.phase === "confirm-download" && voice.model && <div className="voice-input__panel" role="dialog" aria-label={t("下載本機語音模型")}>
      <strong>{t("下載本機語音模型：{name}", { name: voice.model.name })}</strong>
      <p>{t("首次使用語音輸入需下載一次本機轉寫模型（約 {size}），下載後可離線使用；語音資料不會離開這台電腦。", { size: formatBytes(voice.model.totalBytes) })}</p>
      <dl className="voice-input__model-details">
        <div><dt>{t("模型檔")}</dt><dd><code>{voice.model.fileName}</code></dd></div>
        <div><dt>{t("儲存位置")}</dt><dd>{t("Pixel Crew 應用程式資料目錄的 voice-models 資料夾")}</dd></div>
      </dl>
      <div className="voice-input__panel-actions">
        <button type="button" onClick={() => voice.confirmDownload()}>{t("下載並啟用")}</button>
        <button type="button" onClick={() => voice.cancel()}>{t("取消")}</button>
      </div>
    </div>}
    {voice.phase === "downloading" && voice.model && <div className="voice-input__panel" role="status" aria-live="polite">
      <strong>{t("正在下載語音模型…")}</strong>
      <div className="voice-input__progress"><div style={{ width: `${Math.min(100, Math.round((voice.model.bytesDownloaded / Math.max(1, voice.model.totalBytes)) * 100))}%` }} /></div>
    </div>}
    {voice.phase === "error" && voice.error && <span className="voice-input__error" role="alert">{voice.error}</span>}
  </span>;
}
