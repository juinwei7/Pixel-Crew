import { useEffect, useRef, useState, type ReactNode } from "react";
import { t } from "../i18n";
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
  direction?: "left" | "right";
};

// 66px keeps a clear gap between neighbouring 34px circles across the 140°
// fan (chord ≈ 40px). The CSS multiplies offsets by --npc-zoom so the ring
// grows with the camera and never sits on top of a zoomed-in sprite.
const RADIUS = 66;
/** Fan the buttons to one side of the NPC. GameCanvas selects the outward side
 *  and flips it near an edge, reducing collisions with the adjacent seat. */
function arcOffset(index: number, count: number, direction: "left" | "right"): { x: number; y: number } {
  const start = direction === "left" ? 250 : 70;
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

// 選到一項之後先讓其他按鈕收回中心、被選的那顆脈衝一下，再真的執行動作。
// 跟 styles/motion.css 的 .npc-radial--closing 時長一致（var(--dur-2)）。
const CHOOSE_MS = 170;
// 每顆按鈕比前一顆晚這麼久放射出去。
const STAGGER_MS = 32;

export function NpcRadialMenu({ worker, canRemove, onRename, onAvatar, onPersona, onRoom, onRemove, onClose, direction = "right" }: Props) {
  const [mode, setMode] = useState<"ring" | "rename">("ring");
  const [draft, setDraft] = useState(worker.name);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  // 鍵盤游標（方向鍵沿弧線移動）；-1 = 還沒用鍵盤，hover 由 CSS 自己處理。
  const [activeIndex, setActiveIndex] = useState(-1);
  const [chosen, setChosen] = useState<string | null>(null);
  const buttonRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const chooseTimerRef = useRef<number | null>(null);

  useEffect(() => {
    // Mount collapsed at the sprite's center, then flip the class on the next
    // frame so the CSS transition fans the buttons out along the arc.
    const frame = requestAnimationFrame(() => setOpen(true));
    return () => {
      cancelAnimationFrame(frame);
      if (chooseTimerRef.current !== null) window.clearTimeout(chooseTimerRef.current);
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (mode === "ring") onClose();
        else { setMode("ring"); setError(null); }
        return;
      }
      // 方向鍵：沿弧線順時針／逆時針換一顆。上下左右都收，因為弧線朝哪邊開
      // 取決於 NPC 在畫面的哪一側，使用者不該需要先想「現在是哪個方向」。
      if (mode !== "ring" || chosen) return;
      const step = event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : event.key === "ArrowUp" || event.key === "ArrowLeft" ? -1 : 0;
      if (!step) return;
      event.preventDefault();
      setActiveIndex((index) => {
        const next = index < 0 ? (step > 0 ? 0 : itemCount - 1) : (index + step + itemCount) % itemCount;
        buttonRefs.current[next]?.focus();
        return next;
      });
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  async function saveName() {
    const result = await onRename(worker.id, draft);
    if (result) { setError(result); return; }
    onClose();
  }

  const items = [
    { key: "rename", label: t("重新命名"), danger: false, act: () => setMode("rename") },
    { key: "persona", label: t("個性 / 職務"), danger: false, act: () => { onPersona(worker.id); onClose(); } },
    { key: "avatar", label: t("像素角色"), danger: false, act: () => { onAvatar(worker.id); onClose(); } },
    { key: "room", label: t("切換房間"), danger: false, act: () => { onRoom(worker.id); onClose(); } },
    ...(canRemove ? [{
      key: "remove", label: t("移除人員"), danger: true,
      // onRemove (handleRemoveWorker in App.tsx) already gates this behind
      // its own ConfirmDialog — no local confirm step needed here.
      act: () => { onRemove(worker.id); onClose(); },
    }] : []),
  ];
  const itemCount = items.length;

  // 改名是原地換成輸入框，不用等收合動畫；其餘動作先播「選中」再執行。
  function choose(item: (typeof items)[number]) {
    if (chosen) return;
    if (item.key === "rename") { item.act(); return; }
    setChosen(item.key);
    chooseTimerRef.current = window.setTimeout(() => {
      chooseTimerRef.current = null;
      item.act();
    }, CHOOSE_MS);
  }

  return (
    <div className={`npc-radial npc-radial--${direction}${open ? " npc-radial--open" : ""}${chosen ? " npc-radial--closing" : ""}`} onClick={(event) => event.stopPropagation()}>
      {mode === "ring" && <span className="npc-radial__hub" aria-hidden="true" />}
      {mode === "ring" && items.map((item, index) => {
        const { x, y } = arcOffset(index, items.length, direction);
        return (
          <button
            key={item.key}
            ref={(element) => { buttonRefs.current[index] = element; }}
            type="button"
            aria-label={item.label}
            className={`npc-radial__item${item.danger ? " npc-radial__item--danger" : ""}`}
            data-active={activeIndex === index ? "true" : undefined}
            data-chosen={chosen === item.key ? "true" : undefined}
            // --d：放射出去的錯開延遲，只套在位移／透明度上（見 motion.css），
            // hover 放大不吃這個延遲，滑過去立刻有反應。
            style={{ "--tx": `${x.toFixed(1)}px`, "--ty": `${y.toFixed(1)}px`, "--d": `${index * STAGGER_MS}ms` } as React.CSSProperties}
            onMouseEnter={() => setActiveIndex(-1)}
            onClick={() => choose(item)}
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
    </div>
  );
}
