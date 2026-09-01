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
  onProviderChange?(provider: ProviderId): void;
  onAccountChange?(id: string | null): void;
  onClose(): void;
  onSelect(path: string): Promise<string | null>;
  onBrowse(): Promise<{ path?: string; canceled?: boolean; error?: string }>;
};

export function WorkspacePicker({ required = false, mode = "move", currentPath, recentPaths, resetsConversation, newWorkerProvider, accounts, accountId, onProviderChange, onAccountChange, onClose, onSelect, onBrowse }: Props) {
  const [path, setPath] = useState(currentPath);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const windows = typeof navigator !== "undefined" && /Win/i.test(navigator.platform);
  const creating = required || mode === "create";
  const title = required ? t("準備開始，想處理什麼？") : creating ? t("新 NPC 要在哪裡工作？") : t("選擇工作位置");

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
      label={title}
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
            <div className="workspace-picker__eyebrow">{required ? "LET'S GET STARTED" : creating ? "NEW CREW STATION" : "ENTER A ROOM"}</div>
            <h2>{title}</h2>
            <p>{required
              ? t("你不需要先準備專案。直接開始就能交辦事情；若要處理現有檔案，再選擇它所在的資料夾。")
              : creating
                ? t("先選擇一個本機資料夾作為新 NPC 的房間；確認後才會建立人員與工位。")
                : t("一個資料夾就是一間工作房間；目前 NPC 會直接搬到新位置。")}</p>
          </div>
        </header>

        {required && (
          <button type="button" className="workspace-picker__default" disabled={pending} onClick={() => void choose(currentPath)}>
            <span className="workspace-picker__default-mark" aria-hidden="true">✓</span>
            <span><strong>{t("直接開始")}</strong><small>{t("還沒有現成專案也沒關係，Pixel Crew 會準備工作空間")}</small></span>
            <b>{t("最簡單")}</b>
          </button>
        )}

        {creating && newWorkerProvider && (() => {
          const accountsByProvider = {
            claude: accounts?.filter((account) => account.provider === "claude") ?? [],
            codex: accounts?.filter((account) => account.provider === "codex") ?? [],
          };
          const selectedAccount = accountId ? accounts?.find((account) => account.id === accountId) : null;
          const selectedProvider = selectedAccount?.provider ?? newWorkerProvider;
          return (
          <div className="workspace-picker__label" style={{ marginTop: 0 }}>
            <label htmlFor="workspace-account">{t("選擇 AI 帳號")}</label>
            <select
              id="workspace-account"
              className="workspace-picker__input"
              value={`${selectedProvider}:${accountId ?? ""}`}
              onChange={(event) => {
                const [provider, nextAccountId] = event.target.value.split(":", 2) as [ProviderId, string];
                if (provider !== "claude" && provider !== "codex") return;
                onProviderChange?.(provider);
                onAccountChange?.(nextAccountId || null);
              }}
            >
              {(["claude", "codex"] as ProviderId[]).map((provider) => (
                <optgroup key={provider} label={provider === "claude" ? "Claude Code" : "Codex"}>
                  <option value={`${provider}:`}>{provider === "claude" ? "Claude Code" : "Codex"} · {t("使用共用登入")}</option>
                  {accountsByProvider[provider].map((account) => (
                    <option key={account.id} value={`${provider}:${account.id}`} disabled={account.auth?.status !== "authenticated"}>
                      {provider === "claude" ? "Claude Code" : "Codex"} · {account.label}{account.auth?.status !== "authenticated" ? t("（尚未登入）") : ""}
                    </option>
                  ))}
                </optgroup>
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
            <strong>{pending ? t("正在開啟…") : required ? t("我要處理現有專案") : t("從系統選擇資料夾")}</strong>
            <small>{required ? t("選擇網站、文件或其他檔案所在的資料夾") : t("瀏覽這台電腦上的專案")}</small>
          </span>
          <span className="workspace-picker__browse-arrow" aria-hidden="true">→</span>
        </button>

        <div className="workspace-picker__divider"><span>{required ? t("進階：直接輸入專案位置") : t("或貼上完整路徑")}</span></div>

        <label className="workspace-picker__label" htmlFor="workspace-path">
          {required ? t("專案資料夾位置") : t("本機絕對路徑")}
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
            {pending ? t("請稍候…") : required ? t("用這個位置開始") : creating ? t("在此建立工位") : resetsConversation ? t("搬遷並重設對話") : t("搬到此位置")}
          </button>
        </div>
      </form>
    </Modal>
  );
}
