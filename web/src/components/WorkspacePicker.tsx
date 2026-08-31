import { useEffect, useState } from "react";
import type { AccountWithAuth, ProviderId } from "../types";
import { roomName } from "../workspace";
import { t } from "../i18n";
import { Modal } from "./Modal";

type Props = {
  required?: boolean;
  mode?: "create" | "move";
  currentPath: string;
  recentPaths: string[];
  resetsConversation: boolean;
  // Only meaningful when mode === "create": lets the new NPC use its own
  // named account instead of the shared login. Omit both when not applicable
  // (no named accounts for this provider yet, or moving an existing NPC).
  newWorkerProvider?: ProviderId;
  accounts?: AccountWithAuth[];
  accountId?: string | null;
  onAccountChange?(id: string | null): void;
  onClose(): void;
  onSelect(path: string): Promise<string | null>;
  onBrowse(): Promise<{ path?: string; canceled?: boolean; error?: string }>;
};

export function WorkspacePicker({ required = false, mode = "move", currentPath, recentPaths, resetsConversation, newWorkerProvider, accounts, accountId, onAccountChange, onClose, onSelect, onBrowse }: Props) {
  const [path, setPath] = useState(currentPath);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const windows = typeof navigator !== "undefined" && /Win/i.test(navigator.platform);
  const creating = required || mode === "create";

  useEffect(() => setPath(currentPath), [currentPath]);
  // ×／Esc 共用同一個關閉入口：首次設定（required）永遠不准關，其餘忙碌中不准關。
  function closeIfAllowed() { if (!required && !pending) onClose(); }

  async function choose(nextPath: string) {
    const trimmed = nextPath.trim();
    if (!trimmed || pending) return;
    setPending(true);
    setError(null);
    const nextError = await onSelect(trimmed);
    setPending(false);
    if (nextError) setError(nextError);
    else onClose();
  }

  async function browse() {
    if (pending) return;
    setPending(true);
    setError(null);
    const result = await onBrowse();
    if (result.error) {
      setError(result.error);
      setPending(false);
      return;
    }
    if (result.canceled || !result.path) {
      setPending(false);
      return;
    }
    setPath(result.path);
    const nextError = await onSelect(result.path);
    setPending(false);
    if (nextError) setError(nextError);
    else onClose();
  }

  return (
    <Modal
      label={required ? t("先設定安全工作區") : creating ? t("新 NPC 要在哪裡工作？") : t("選擇工作位置")}
      overlayClassName="workspace-picker"
      cardClassName="workspace-picker__card"
      closeClassName="workspace-picker__close"
      closeLabel={t("關閉")}
      hideClose={required}
      onClose={closeIfAllowed}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void choose(path);
        }}
      >
        <header className="workspace-picker__header">
          <div className="workspace-picker__glyph" aria-hidden="true" />
          <div>
            <div className="workspace-picker__eyebrow">{required ? "FIRST ROOM SETUP" : creating ? "NEW CREW STATION" : "ENTER A ROOM"}</div>
            <h2>{required ? t("先設定安全工作區") : creating ? t("新 NPC 要在哪裡工作？") : t("選擇工作位置")}</h2>
            <p>{required
              ? t("Pixel Crew 不會直接使用你的整個使用者目錄。請選擇專案，或使用已建立的專用工作區。")
              : creating
                ? t("先選擇一個本機資料夾作為新 NPC 的房間；確認後才會建立人員與工位。")
                : t("一個資料夾就是一間工作房間；目前 NPC 會直接搬到新位置。")}</p>
          </div>
        </header>

        {required && (
          <button type="button" className="workspace-picker__default" disabled={pending} onClick={() => void choose(currentPath)}>
            <span className="workspace-picker__default-mark" aria-hidden="true">✓</span>
            <span><strong>{t("使用 Pixel Crew 專用工作區")}</strong><small>{currentPath}</small></span>
            <b>{t("建議")}</b>
          </button>
        )}

        {creating && newWorkerProvider && (() => {
          const providerAccounts = accounts?.filter((account) => account.provider === newWorkerProvider) ?? [];
          if (providerAccounts.length === 0) return null;
          const providerLabel = newWorkerProvider === "codex" ? "Codex" : "Claude";
          return (
          <div className="workspace-picker__label" style={{ marginTop: 0 }}>
            <label htmlFor="workspace-account">{t("{provider} 帳號", { provider: providerLabel })}</label>
            <select
              id="workspace-account"
              className="workspace-picker__input"
              value={accountId ?? ""}
              onChange={(event) => onAccountChange?.(event.target.value || null)}
            >
              <option value="">{t("使用共用登入")}</option>
              {providerAccounts.map((account) => (
                <option key={account.id} value={account.id} disabled={account.auth?.status !== "authenticated"}>
                  {account.label}{account.auth?.status !== "authenticated" ? t("（尚未登入）") : ""}
                </option>
              ))}
            </select>
          </div>
          );
        })()}

        {resetsConversation && (
          <div className="workspace-picker__reset-warning">
            {t("這位 NPC 已有對話。搬到其他專案時會重設其 CLI session 與對話紀錄，但不會新增 NPC。")}
          </div>
        )}

        <button
          type="button"
          className="workspace-picker__browse"
          disabled={pending}
          onClick={() => void browse()}
        >
          <span className="workspace-picker__browse-icon" aria-hidden="true" />
          <span className="workspace-picker__browse-copy">
            <strong>{pending ? t("正在開啟…") : t("從系統選擇資料夾")}</strong>
            <small>{t("瀏覽這台電腦上的專案")}</small>
          </span>
          <span className="workspace-picker__browse-arrow" aria-hidden="true">→</span>
        </button>

        <div className="workspace-picker__divider"><span>{required ? t("或指定現有專案") : t("或貼上完整路徑")}</span></div>

        <label className="workspace-picker__label" htmlFor="workspace-path">
          {t("本機絕對路徑")}
        </label>
        <div className="workspace-picker__path-row">
          <input
            id="workspace-path"
            className="workspace-picker__input"
            value={path}
            onChange={(event) => setPath(event.target.value)}
            placeholder={windows ? "C:\\Users\\name\\Projects\\my-repo" : "/Users/name/projects/my-repo"}
            autoFocus
          />
        </div>

        {recentPaths.length > 0 && (
          <div className="workspace-picker__recent">
            <div className="workspace-picker__label">{t("最近房間")}</div>
            {recentPaths.map((recentPath) => (
              <button
                key={recentPath}
                type="button"
                className={recentPath === currentPath ? "workspace-picker__room workspace-picker__room--current" : "workspace-picker__room"}
                disabled={pending}
                onClick={() => void choose(recentPath)}
              >
                <span className="workspace-picker__room-marker" aria-hidden="true" />
                <span className="workspace-picker__room-copy">
                  <strong>{roomName(recentPath)}</strong>
                  <small>{recentPath}</small>
                </span>
                {recentPath === currentPath
                  ? <span className="workspace-picker__current">{t("目前")}</span>
                  : <span className="workspace-picker__room-arrow" aria-hidden="true">↗</span>}
              </button>
            ))}
          </div>
        )}

        {error && <div className="workspace-picker__error">{error}</div>}
        <div className="workspace-picker__actions">
          {!required && <button type="button" onClick={onClose} disabled={pending}>{t("取消")}</button>}
          <button type="submit" className="workspace-picker__confirm" disabled={pending || !path.trim()}>
            {pending ? t("請稍候…") : creating ? t("在此建立工位") : resetsConversation ? t("搬遷並重設對話") : t("搬到此位置")}
          </button>
        </div>
      </form>
    </Modal>
  );
}
