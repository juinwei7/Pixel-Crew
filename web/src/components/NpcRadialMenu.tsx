import { useEffect, useState, type ReactNode } from "react";
import type { WorkerState } from "../types";

type Props = {
  worker: WorkerState;
  canRemove: boolean;
  onRename(id: string, name: string): Promise<string | null>;
  onAvatar(id: string): void;
  onPersona(id: string): void;
  onRoom(id: string): void;
  onRemove(id: string): void;
  onClose(): void;
};

// 66px keeps a clear gap between neighbouring 34px circles across the 140°
// fan (chord ≈ 40px). The CSS multiplies offsets by --npc-zoom so the ring
// grows with the camera and never sits on top of a zoomed-in sprite.
const RADIUS = 66;
/** Fan the buttons across the lower arc (160° → 20°, screen coords, y down)
 *  so they never collide with the nameplate / speech bubble above the NPC. */
function arcOffset(index: number, count: number): { x: number; y: number } {
  const start = 160;
  const span = 140;
  const angle = ((start - (count > 1 ? (index * span) / (count - 1) : span / 2)) * Math.PI) / 180;
  return { x: Math.cos(angle) * RADIUS, y: Math.sin(angle) * RADIUS };
}

const ICONS: Record<string, ReactNode> = {
  rename: (
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20l4.5-1L19 8.5l-3.5-3.5L5 15.5 4 20z" /><path d="M13 7.5l3.5 3.5" /></svg>
  ),
  persona: (
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4h14v8a7 7 0 0 1-14 0V4z" /><circle cx="9.5" cy="9" r="0.6" /><circle cx="14.5" cy="9" r="0.6" /><path d="M9 13.5c1 1.2 5 1.2 6 0" /></svg>
  ),
  avatar: (
    <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="7" height="7" /><rect x="13" y="4" width="7" height="7" /><rect x="4" y="13" width="7" height="7" /><rect x="13" y="13" width="7" height="7" /></svg>
  ),
  room: (
    <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="3" width="10" height="18" /><circle cx="14" cy="12" r="0.8" /></svg>
  ),
  remove: (
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14" /><path d="M9.5 7V4.5h5V7" /><path d="M7 7l1 13.5h8L17 7" /></svg>
  ),
};

export function NpcRadialMenu({ worker, canRemove, onRename, onAvatar, onPersona, onRoom, onRemove, onClose }: Props) {
  const [mode, setMode] = useState<"ring" | "rename" | "confirm-remove">("ring");
  const [draft, setDraft] = useState(worker.name);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const hasHistory = worker.busy || worker.turns.length > 0;

  useEffect(() => {
    // Mount collapsed at the sprite's center, then flip the class on the next
    // frame so the CSS transition fans the buttons out along the arc.
    const frame = requestAnimationFrame(() => setOpen(true));
    return () => cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (mode === "ring") onClose();
      else { setMode("ring"); setError(null); }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [mode, onClose]);

  async function saveName() {
    const result = await onRename(worker.id, draft);
    if (result) { setError(result); return; }
    onClose();
  }

  const items = [
    { key: "rename", label: "重新命名", danger: false, act: () => setMode("rename") },
    { key: "persona", label: "個性 / 職務", danger: false, act: () => { onPersona(worker.id); onClose(); } },
    { key: "avatar", label: "像素角色", danger: false, act: () => { onAvatar(worker.id); onClose(); } },
    { key: "room", label: "切換房間", danger: false, act: () => { onRoom(worker.id); onClose(); } },
    ...(canRemove ? [{
      key: "remove", label: "移除人員", danger: true,
      act: () => { if (hasHistory) setMode("confirm-remove"); else { onRemove(worker.id); onClose(); } },
    }] : []),
  ];

  return (
    <div className={`npc-radial${open ? " npc-radial--open" : ""}`} onClick={(event) => event.stopPropagation()}>
      {mode === "ring" && items.map((item, index) => {
        const { x, y } = arcOffset(index, items.length);
        return (
          <button
            key={item.key}
            type="button"
            aria-label={item.label}
            className={`npc-radial__item${item.danger ? " npc-radial__item--danger" : ""}`}
            style={{ "--tx": `${x.toFixed(1)}px`, "--ty": `${y.toFixed(1)}px`, transitionDelay: `${index * 35}ms` } as React.CSSProperties}
            onClick={item.act}
          >
            {ICONS[item.key]}
            <span className="npc-radial__label">{item.label}</span>
          </button>
        );
      })}
      {mode === "rename" && (
        <div className="npc-radial__panel">
          <input
            value={draft}
            maxLength={24}
            autoFocus
            className={error ? "npc-radial__input--error" : ""}
            onChange={(event) => { setDraft(event.target.value); setError(null); }}
            onKeyDown={(event) => {
              if (event.key === "Enter") { event.preventDefault(); void saveName(); }
              if (event.key === "Escape") { event.stopPropagation(); setMode("ring"); setError(null); }
            }}
          />
          {error && <small className="npc-radial__error">{error}</small>}
        </div>
      )}
      {mode === "confirm-remove" && (
        <div className="npc-radial__panel">
          <small>確定移除 {worker.name}？</small>
          <div className="npc-radial__confirm">
            <button type="button" className="npc-radial__confirm-danger" onClick={() => { onRemove(worker.id); onClose(); }}>移除</button>
            <button type="button" onClick={() => setMode("ring")}>取消</button>
          </div>
        </div>
      )}
    </div>
  );
}
