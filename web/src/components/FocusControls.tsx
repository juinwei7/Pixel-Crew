import { useEffect, useRef, useState } from "react";
import type { AutoApproveMode, ProviderId, WorkerState } from "../types";
import { t, tc } from "../i18n";

type ModelOption = { id: string; label: string; description?: string };

type Props = {
  active?: WorkerState;
  workerCount: number;
  modelOptions: ModelOption[];
  authReady: boolean;
  providerChanging?: boolean;
  notificationsEnabled: boolean;
  onModel(model: string): void;
  onAutoApprove(mode: AutoApproveMode): void;
  onProvider(provider: ProviderId): void;
  onRename(id: string, name: string): Promise<string | null>;
  onPersona(): void;
  onAvatar(): void;
  onRoom(): void;
  onRemove(id: string): void;
  onCreateNpc(): void;
  onCreateDepartment?(): void;
  onOpenMcp(): void;
  onOpenBackup(): void;
  onNotificationsToggle(): void;
  onOpenCommandCenter(): void;
};

export function FocusControls({
  active,
  workerCount,
  modelOptions,
  authReady,
  providerChanging = false,
  notificationsEnabled,
  onModel,
  onAutoApprove,
  onProvider,
  onRename,
  onPersona,
  onAvatar,
  onRoom,
  onRemove,
  onCreateNpc,
  onCreateDepartment,
  onOpenMcp,
  onOpenBackup,
  onNotificationsToggle,
  onOpenCommandCenter,
}: Props) {
  const [open, setOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", closeOutside);
    return () => window.removeEventListener("pointerdown", closeOutside);
  }, [open]);

  useEffect(() => {
    if (!open) {
      setRenaming(false);
      setRenameError(null);
      setConfirmRemove(false);
    }
  }, [open]);

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    if (renaming) {
      setRenaming(false);
      setRenameError(null);
      return;
    }
    if (confirmRemove) {
      setConfirmRemove(false);
      return;
    }
    setOpen(false);
  }

  async function saveName() {
    if (!active) return;
    const error = await onRename(active.id, draft);
    if (error) {
      setRenameError(error);
      return;
    }
    setRenaming(false);
    setRenameError(null);
  }

  return (
    <div ref={rootRef} className="focus-controls" onKeyDown={handleKeyDown}>
      <button
        type="button"
        className="focus-controls__trigger"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-label={t("專心模式管理面板")}
      >
        <span aria-hidden="true">⚙</span> {t("管理")}
      </button>
      {open && (
        <div className="focus-controls__panel" role="menu" aria-label={t("專心模式功能")}>
          <section>
            <h4>{t("目前 NPC")}</h4>
            {active ? (
              <>
                <label className="focus-controls__row">
                  <span>{t("模型")}</span>
                  <select
                    value={active.model ?? ""}
                    disabled={active.busy || !authReady || modelOptions.length === 0}
                    onChange={(event) => onModel(event.target.value)}
                  >
                    {modelOptions.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
                  </select>
                </label>
                <label className="focus-controls__row">
                  <span>{t("自動核准")}</span>
                  <select
                    className={`focus-controls__auto-approve focus-controls__auto-approve--${active.autoApproveMode}`}
                    value={active.autoApproveMode}
                    onChange={(event) => onAutoApprove(event.target.value as AutoApproveMode)}
                  >
                    <option value="off">{tc("自動核准", "關閉")}</option>
                    <option value="safe">{t("安全")}</option>
                    <option value="full">{t("完全")}</option>
                    <option value="invincible">{t("⚡ 無限制")}</option>
                  </select>
                </label>
                <label className="focus-controls__row">
                  <span>{t("引擎")}</span>
                  <select
                    value={active.provider}
                    disabled={active.busy || providerChanging}
                    onChange={(event) => onProvider(event.target.value as ProviderId)}
                  >
                    <option value="claude">Claude Code</option>
                    <option value="codex">Codex</option>
                  </select>
                </label>
                <div className="focus-controls__row">
                  <span>{t("名稱")}</span>
                  {renaming ? (
                    <span className="focus-controls__rename">
                      <input
                        value={draft}
                        autoFocus
                        maxLength={24}
                        className={renameError ? "focus-controls__rename--error" : ""}
                        title={renameError ?? t("Enter 儲存，Esc 取消")}
                        onChange={(event) => { setDraft(event.target.value); setRenameError(null); }}
                        onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void saveName(); } }}
                      />
                      <button type="button" onClick={() => void saveName()}>{t("儲存")}</button>
                    </span>
                  ) : (
                    <button type="button" onClick={() => { setRenaming(true); setConfirmRemove(false); setDraft(active.name); setRenameError(null); }}>
                      {t("{name} · 改名", { name: active.name })}
                    </button>
                  )}
                </div>
                <div className="focus-controls__actions">
                  <button type="button" onClick={() => { onPersona(); setOpen(false); }}>{t("個性 / 職務")}</button>
                  <button type="button" onClick={() => { onAvatar(); setOpen(false); }}>{t("像素角色")}</button>
                  <button type="button" onClick={() => { onRoom(); setOpen(false); }}>{t("切換房間")}</button>
                </div>
                {workerCount > 1 && (
                  confirmRemove ? (
                    <div className="focus-controls__confirm">
                      <span>{t("確定移除 {name}？", { name: active.name })}</span>
                      <button type="button" className="focus-controls__danger" onClick={() => { onRemove(active.id); setConfirmRemove(false); setOpen(false); }}>{t("移除")}</button>
                      <button type="button" onClick={() => setConfirmRemove(false)}>{t("取消")}</button>
                    </div>
                  ) : (
                    <div className="focus-controls__actions">
                      <button
                        type="button"
                        className="focus-controls__danger"
                        onClick={() => {
                          if (active.busy || active.turns.length > 0) {
                            setRenaming(false);
                            setRenameError(null);
                            setConfirmRemove(true);
                          } else {
                            onRemove(active.id);
                            setOpen(false);
                          }
                        }}
                      >
                        {t("移除人員")}
                      </button>
                    </div>
                  )
                )}
              </>
            ) : <p className="focus-controls__empty">{t("尚未選擇 NPC")}</p>}
          </section>
          <section>
            <h4>{t("團隊")}</h4>
            <div className="focus-controls__actions">
              <button type="button" onClick={() => { onCreateNpc(); setOpen(false); }}>{t("＋ 新增 NPC")}</button>
              {onCreateDepartment && <button type="button" onClick={() => { onCreateDepartment(); setOpen(false); }}>{t("＋ 建立部門")}</button>}
              <button type="button" onClick={() => { onOpenMcp(); setOpen(false); }}>{t("MCP 伺服器")}</button>
              <button type="button" onClick={() => { onOpenBackup(); setOpen(false); }}>{t("備份與還原")}</button>
              <button type="button" onClick={() => { onOpenCommandCenter(); setOpen(false); }}>{t("指令庫")}</button>
            </div>
            <label className="focus-controls__row focus-controls__notify">
              <span>{t("桌面通知")}</span>
              <input type="checkbox" checked={notificationsEnabled} onChange={onNotificationsToggle} />
            </label>
          </section>
        </div>
      )}
    </div>
  );
}
