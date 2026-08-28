import { useRef, useState } from "react";
import { t } from "../i18n";
import { apiAssetUrl, apiRequest, apiUpload } from "../api";
import { Modal } from "./Modal";

type ValidateResult = {
  importToken: string;
  exportedAt: string | null;
  appVersion: string | null;
  workerCount: number;
  avatarCount: number;
  warnings: string[];
};

type Props = {
  notify(message: string, tone?: "ok" | "error" | "info"): void;
  onClose(): void;
};

const CONFIRM_PHRASE = "RESTORE";

export function BackupModal({ notify, onClose }: Props) {
  const [uploading, setUploading] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [validated, setValidated] = useState<ValidateResult | null>(null);
  const [confirmText, setConfirmText] = useState("");
  const [commitOutcome, setCommitOutcome] = useState<{ ok: boolean; text: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // A restore commit is a real, in-flight server-side operation once fired —
  // closing the dialog can't cancel it (no AbortController on that request,
  // deliberately: the server may already be mid-swap by the time any abort
  // would arrive). Block both close paths while it's running so the user
  // never loses the outcome message believing they stopped anything.
  function handleClose() {
    if (committing) return;
    if (validated) void discardValidated();
    onClose();
  }

  async function discardValidated() {
    if (!validated) return;
    try {
      await apiRequest(`/api/backup/import/${encodeURIComponent(validated.importToken)}`, { method: "DELETE" });
    } catch {
      // Best-effort — the server auto-discards abandoned uploads after 10 minutes anyway.
    }
    setValidated(null);
    setConfirmText("");
  }

  async function handleFileSelected() {
    const file = fileInputRef.current?.files?.[0];
    if (!file) return;
    setUploading(true);
    setError(null);
    setCommitOutcome(null);
    try {
      const formData = new FormData();
      formData.append("backup", file);
      const result = await apiUpload<ValidateResult>("/api/backup/import/validate", formData, { timeoutMs: 120000 });
      setValidated(result);
    } catch (uploadError) {
      setError((uploadError as Error).message);
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function commit() {
    if (!validated || confirmText !== CONFIRM_PHRASE) return;
    setCommitting(true);
    setError(null);
    try {
      const result = await apiRequest<{ ok: boolean; message: string }>("/api/backup/import/commit", {
        method: "POST",
        body: { importToken: validated.importToken, confirmPhrase: confirmText },
        timeoutMs: 60000,
      });
      setCommitOutcome({ ok: result.ok, text: result.message });
      notify(result.message, result.ok ? "ok" : "error");
    } catch (commitError) {
      // The server intentionally exits right after responding — a network
      // failure here is expected, not necessarily a real failure. The
      // original data is safe either way (pre-restore snapshot kept on
      // disk), and the next launch's system status confirms the outcome.
      setCommitOutcome({
        ok: false,
        text: t("還原請求已送出，伺服器可能已結束連線。請重新啟動 Pixel Crew 並確認畫面是否已顯示還原後的資料；如未成功，原始資料已保留在備份中。"),
      });
      notify((commitError as Error).message, "info");
    } finally {
      setCommitting(false);
      setValidated(null);
      setConfirmText("");
    }
  }

  return (
    <Modal label={t("備份與還原")} overlayClassName="backup-modal" cardClassName="backup-modal__card" closeClassName="backup-modal__close" closeLabel={t("關閉備份與還原")} onClose={handleClose}>
        <header className="backup-modal__header">
          <span className="backup-modal__eyebrow">BACKUP &amp; RESTORE</span>
          <h2>{t("備份與還原")}</h2>
        </header>

        <section className="backup-modal__section">
          <h3>{t("匯出備份")}</h3>
          <p className="backup-modal__hint">
            {t("將所有工人、對話紀錄與角色圖片打包成一個檔案，可用系統工具自行檢查。匯出備份不會中斷正在執行的工人。")}
          </p>
          <a className="backup-modal__export" href={apiAssetUrl("/api/backup/export")} download>
            {t("下載備份（.tar.gz）")}
          </a>
        </section>

        <section className="backup-modal__section">
          <h3>{t("匯入還原")}</h3>
          {commitOutcome ? (
            <div className={`backup-modal__notice ${commitOutcome.ok ? "" : "backup-modal__notice--err"}`} aria-live="polite">
              {commitOutcome.text}
            </div>
          ) : !validated ? (
            <>
              <p className="backup-modal__hint">{t("選擇先前匯出的備份檔案（.tar.gz），系統會先驗證內容再詢問是否還原。")}</p>
              <input
                ref={fileInputRef}
                type="file"
                accept=".gz,application/gzip"
                aria-label={t("選擇備份檔案")}
                disabled={uploading}
                onChange={() => void handleFileSelected()}
              />
              {uploading && <div className="backup-modal__hint" aria-live="polite">{t("正在上傳並檢查備份檔案…")}</div>}
            </>
          ) : (
            <div className="backup-modal__summary">
              <div className="backup-modal__summary-row">
                <span>{t("匯出時間")}</span>
                <span>{validated.exportedAt ?? t("未知")}</span>
              </div>
              <div className="backup-modal__summary-row">
                <span>{t("匯出版本")}</span>
                <span>{validated.appVersion ?? t("未知")}</span>
              </div>
              <div className="backup-modal__summary-row">
                <span>{t("工人數量")}</span>
                <span>{validated.workerCount}</span>
              </div>
              <div className="backup-modal__summary-row">
                <span>{t("角色圖片")}</span>
                <span>{validated.avatarCount}</span>
              </div>
              {validated.warnings.map((warning) => (
                <div key={warning} className="backup-modal__warning" aria-live="polite">{warning}</div>
              ))}
              <div className="backup-modal__danger" aria-live="polite">
                {t("還原將覆蓋目前所有工人、對話紀錄與角色圖片。還原前會自動保留一份備份，但操作本身無法復原。還原完成後 Pixel Crew 伺服器會自動結束，請手動重新啟動應用程式。")}
              </div>
              <label className="backup-modal__confirm-label">
                {t("輸入 {phrase} 以確認", { phrase: CONFIRM_PHRASE })}
                <input
                  className="backup-modal__input"
                  value={confirmText}
                  onChange={(event) => setConfirmText(event.target.value)}
                  placeholder={CONFIRM_PHRASE}
                  disabled={committing}
                />
              </label>
              {confirmText.length > 0 && confirmText !== CONFIRM_PHRASE && (
                <div className="backup-modal__confirm-hint">{t("文字必須完全符合「{phrase}」（區分大小寫）", { phrase: CONFIRM_PHRASE })}</div>
              )}
              <div className="backup-modal__actions">
                <button type="button" onClick={() => void discardValidated()} disabled={committing}>{t("取消")}</button>
                <button
                  type="button"
                  className="backup-modal__commit"
                  disabled={committing || confirmText !== CONFIRM_PHRASE}
                  onClick={() => void commit()}
                >
                  {committing ? t("還原中…") : t("確認還原")}
                </button>
              </div>
            </div>
          )}
          {error && <div className="backup-modal__notice backup-modal__notice--err" aria-live="polite">{error}</div>}
        </section>
    </Modal>
  );
}
