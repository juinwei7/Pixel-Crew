import { useState } from "react";
import type { WorkerState } from "../types";
import { SHIRT_COLORS } from "../game/person";
import { roomName } from "../workspace";

type Props = {
  workers: WorkerState[];
  activeId: string | null;
  onSelect(id: string): void;
  onCreate(): void;
  onClose(id: string): void;
  onRename(id: string, name: string): Promise<string | null>;
};

const MAX_WORKERS = 20;

function shirtColor(index: number): string {
  const [color] = SHIRT_COLORS[index % SHIRT_COLORS.length];
  return `#${color.toString(16).padStart(6, "0")}`;
}

export function WorkerTabs({ workers, activeId, onSelect, onCreate, onClose, onRename }: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);

  async function saveName(id: string) {
    const error = await onRename(id, draft);
    if (error) {
      setRenameError(error);
      return;
    }
    setEditingId(null);
    setRenameError(null);
  }

  return (
    <div className="worker-tabs">
      <div className="worker-tabs__count">CREW {workers.length}/{MAX_WORKERS}</div>
      {workers.map((w) => (
        <div
          key={w.id}
          className={`worker-tab ${w.id === activeId ? "worker-tab--active" : ""}`}
          onClick={() => onSelect(w.id)}
          title={`${w.name} · ${w.workspacePath}`}
        >
          <span
            className={`worker-tab__dot ${w.busy ? "worker-tab__dot--busy" : ""}`}
            style={{ background: shirtColor(w.colorIndex) }}
          />
          {editingId === w.id ? (
            <input
              className={`worker-tab__rename ${renameError ? "worker-tab__rename--error" : ""}`}
              value={draft}
              maxLength={24}
              autoFocus
              title={renameError ?? "Enter 儲存，Esc 取消"}
              onClick={(event) => event.stopPropagation()}
              onChange={(event) => {
                setDraft(event.target.value);
                setRenameError(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void saveName(w.id);
                } else if (event.key === "Escape") {
                  setEditingId(null);
                  setRenameError(null);
                }
              }}
            />
          ) : <span className="worker-tab__name">{w.name}</span>}
          <span className={`worker-tab__provider worker-tab__provider--${w.provider}`}>
            {w.provider === "codex" ? "CODEX" : "CLAUDE"}
          </span>
          <span className="worker-tab__room">{roomName(w.workspacePath)}</span>
          {w.model && <span className="worker-tab__model">{w.model}</span>}
          <button
            className="worker-tab__rename-button"
            title={editingId === w.id ? "儲存名稱" : "重新命名"}
            onClick={(event) => {
              event.stopPropagation();
              if (editingId === w.id) void saveName(w.id);
              else {
                setEditingId(w.id);
                setDraft(w.name);
                setRenameError(null);
              }
            }}
          >
            {editingId === w.id ? "✓" : "✎"}
          </button>
          {workers.length > 1 && (
            <button
              className="worker-tab__close"
              title="關閉這個工人"
              onClick={(e) => {
                e.stopPropagation();
                onClose(w.id);
              }}
            >
              ×
            </button>
          )}
        </div>
      ))}
      <button
        className="worker-tabs__add"
        title={workers.length >= MAX_WORKERS ? `最多 ${MAX_WORKERS} 位 NPC` : "新增工人"}
        onClick={onCreate}
        disabled={workers.length >= MAX_WORKERS}
      >
        ＋
      </button>
    </div>
  );
}
