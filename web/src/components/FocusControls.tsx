import { useEffect, useRef, useState } from "react";
import type { WorkerState } from "../types";
import { t } from "../i18n";

type Props = {
  active?: WorkerState;
  workerCount: number;
  onRename(id: string, name: string): Promise<string | null>;
  onPersona(): void;
  onRemove(id: string): void;
  onCreateDepartment?(): void;
};

export function FocusControls({
  active,
  workerCount,
  onRename,
  onPersona,
  onRemove,
  onCreateDepartment,
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
        aria-label={t("專業模式管理面板")}
      >
        <span aria-hidden="true">⚙</span> {t("管理")}
      </button>
      {open && (
        <div className="focus-controls__panel" role="group" aria-label={t("專業模式功能")}>
          <section>
            <h4>{t("目前 NPC")}</h4>
            {active ? (
              <>
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
                  <button type="button" onClick={() => { onPersona(); setOpen(false); }}>{t("職務與指示")}</button>
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
          {onCreateDepartment && <section>
            <h4>{t("團隊")}</h4>
            <div className="focus-controls__actions">
              <button type="button" onClick={() => { onCreateDepartment(); setOpen(false); }}>{t("建立部門")}</button>
            </div>
          </section>}
        </div>
      )}
    </div>
  );
}
