import { useEffect, useState } from "react";
import { roomName } from "../workspace";

type Props = {
  required?: boolean;
  currentPath: string;
  recentPaths: string[];
  resetsConversation: boolean;
  onClose(): void;
  onSelect(path: string): Promise<string | null>;
  onBrowse(): Promise<{ path?: string; canceled?: boolean; error?: string }>;
};

export function WorkspacePicker({ required = false, currentPath, recentPaths, resetsConversation, onClose, onSelect, onBrowse }: Props) {
  const [path, setPath] = useState(currentPath);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const windows = typeof navigator !== "undefined" && /Win/i.test(navigator.platform);

  useEffect(() => setPath(currentPath), [currentPath]);

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
    <div className="workspace-picker" role="dialog" aria-modal="true" aria-labelledby="workspace-title">
      <form
        className="workspace-picker__card"
        onSubmit={(event) => {
          event.preventDefault();
          void choose(path);
        }}
      >
        {!required && <button
          type="button"
          className="workspace-picker__close"
          aria-label="關閉"
          onClick={onClose}
          disabled={pending}
        >
          ×
        </button>}

        <header className="workspace-picker__header">
          <div className="workspace-picker__glyph" aria-hidden="true" />
          <div>
            <div className="workspace-picker__eyebrow">{required ? "FIRST ROOM SETUP" : "ENTER A ROOM"}</div>
            <h2 id="workspace-title">{required ? "先設定安全工作區" : "選擇工作位置"}</h2>
            <p>{required ? "Pixel Crew 不會直接使用你的整個使用者目錄。請選擇專案，或使用已建立的專用工作區。" : "一個資料夾就是一間工作房間；目前 NPC 會直接搬到新位置。"}</p>
          </div>
        </header>

        {required && (
          <button type="button" className="workspace-picker__default" disabled={pending} onClick={() => void choose(currentPath)}>
            <span className="workspace-picker__default-mark" aria-hidden="true">✓</span>
            <span><strong>使用 Pixel Crew 專用工作區</strong><small>{currentPath}</small></span>
            <b>建議</b>
          </button>
        )}

        {resetsConversation && (
          <div className="workspace-picker__reset-warning">
            這位 NPC 已有對話。搬到其他專案時會重設其 CLI session 與對話紀錄，但不會新增 NPC。
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
            <strong>{pending ? "正在開啟…" : "從系統選擇資料夾"}</strong>
            <small>瀏覽這台電腦上的專案</small>
          </span>
          <span className="workspace-picker__browse-arrow" aria-hidden="true">→</span>
        </button>

        <div className="workspace-picker__divider"><span>{required ? "或指定現有專案" : "或貼上完整路徑"}</span></div>

        <label className="workspace-picker__label" htmlFor="workspace-path">
          本機絕對路徑
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
            <div className="workspace-picker__label">最近房間</div>
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
                  ? <span className="workspace-picker__current">目前</span>
                  : <span className="workspace-picker__room-arrow" aria-hidden="true">↗</span>}
              </button>
            ))}
          </div>
        )}

        {error && <div className="workspace-picker__error">{error}</div>}
        <div className="workspace-picker__actions">
          <button type="button" onClick={onClose} disabled={pending}>取消</button>
          <button type="submit" className="workspace-picker__confirm" disabled={pending || !path.trim()}>
            {pending ? "請稍候…" : resetsConversation ? "搬遷並重設對話" : "搬到此位置"}
          </button>
        </div>
      </form>
    </div>
  );
}
