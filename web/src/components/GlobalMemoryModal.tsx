import { useEffect, useRef, useState } from "react";
import type { GlobalMemoryNoteDto } from "../types";
import { apiRequest } from "../api";
import { shouldSubmitComposerKey } from "../composerCore";
import { t } from "../i18n";
import { Modal } from "./Modal";

type Props = {
  globalMemoryEvent: { notes: GlobalMemoryNoteDto[]; seq: number } | null;
  onClose(): void;
};

// Textarea grows with its content up to this many rows, then scrolls
// internally — must match the line-height/padding in the
// .global-memory-modal__add textarea CSS rule.
const NOTE_INPUT_LINE_HEIGHT = 18;
const NOTE_INPUT_VERTICAL_PADDING = 14;
const NOTE_INPUT_MAX_ROWS = 10;
const NOTE_INPUT_MAX_HEIGHT = NOTE_INPUT_LINE_HEIGHT * NOTE_INPUT_MAX_ROWS + NOTE_INPUT_VERTICAL_PADDING;

export function GlobalMemoryModal({ globalMemoryEvent, onClose }: Props) {
  const [notes, setNotes] = useState<GlobalMemoryNoteDto[] | null>(null);
  const [newNote, setNewNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  // A WS broadcast or this modal's own add/delete can land while the
  // mount-time GET below is still in flight; once any of those newer
  // updates arrives, the stale GET must not overwrite them when it resolves.
  const hasNewerUpdate = useRef(false);
  const noteInputRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);

  // Driven by scrollHeight (not a line-count heuristic) so it reacts to
  // every way the value can change — typing, paste, cut, select-all+delete —
  // including a single long line that only grows tall because it wraps.
  useEffect(() => {
    const el = noteInputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, NOTE_INPUT_MAX_HEIGHT)}px`;
  }, [newNote]);

  useEffect(() => {
    let cancelled = false;
    apiRequest<{ notes: GlobalMemoryNoteDto[] }>("/api/memory")
      .then((data) => { if (!cancelled && !hasNewerUpdate.current) setNotes(data.notes ?? []); })
      .catch(() => { if (!cancelled && !hasNewerUpdate.current) setNotes([]); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (globalMemoryEvent) {
      hasNewerUpdate.current = true;
      setNotes(globalMemoryEvent.notes);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [globalMemoryEvent?.seq]);

  async function addNote() {
    const note = newNote.trim();
    if (!note) return;
    try {
      const data = await apiRequest<{ notes: GlobalMemoryNoteDto[] }>("/api/memory", {
        method: "POST",
        body: { note },
      });
      hasNewerUpdate.current = true;
      setNotes(data.notes ?? []);
      setNewNote("");
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function deleteNote(id: string) {
    try {
      const data = await apiRequest<{ notes: GlobalMemoryNoteDto[] }>(`/api/memory/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      hasNewerUpdate.current = true;
      setNotes(data.notes ?? []);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <Modal label={t("全域記憶")} title={t("🧠 全域記憶")} overlayClassName="global-memory-modal" cardClassName="global-memory-modal__card" closeClassName="global-memory-modal__close" closeLabel={t("關閉全域記憶")} onClose={onClose}>
      <p className="global-memory-modal__hint">{t("跨所有 NPC 共用的長期記憶。任何 NPC 學到值得記住的事都會寫在這裡，換一個 NPC 也不會失憶。")}</p>
      {notes === null ? (
        <div className="global-memory-modal__empty">{t("讀取中…")}</div>
      ) : notes.length === 0 ? (
        <div className="global-memory-modal__empty">{t("還沒有全域記憶。跟任何 NPC 聊到你的偏好時它會自己記下來，也可以在下面手動新增。")}</div>
      ) : (
        <ul className="global-memory-modal__list">
          {notes.map((entry) => (
            <li key={entry.id}>
              <span className="global-memory-modal__note">
                {entry.note}
                <span className="global-memory-modal__meta">
                  {entry.sourceWorkerName ? t("由 {name} 記下", { name: entry.sourceWorkerName }) : t("使用者手動新增")}
                  {" · "}
                  <time>{new Date(entry.createdAt).toLocaleString()}</time>
                </span>
              </span>
              <button type="button" onClick={() => void deleteNote(entry.id)} aria-label={t("刪除記憶：{note}", { note: entry.note })} title={t("刪除這則記憶")}>×</button>
            </li>
          ))}
        </ul>
      )}
      <div className="global-memory-modal__add">
        <textarea
          ref={noteInputRef}
          value={newNote}
          rows={1}
          maxLength={200}
          placeholder={t("例：使用者姓名、慣用稱呼、跨專案偏好")}
          onChange={(event) => setNewNote(event.target.value)}
          onCompositionStart={() => { composingRef.current = true; }}
          onCompositionEnd={() => { composingRef.current = false; }}
          onKeyDown={(event) => {
            if (shouldSubmitComposerKey({ key: event.key, shiftKey: event.shiftKey, isComposing: composingRef.current, repeat: event.repeat })) {
              event.preventDefault();
              void addNote();
            }
          }}
        />
        <button type="button" onClick={() => void addNote()} disabled={!newNote.trim()}>{t("＋記住")}</button>
      </div>
      {error && <div className="global-memory-modal__error" role="alert">{error}</div>}
    </Modal>
  );
}
