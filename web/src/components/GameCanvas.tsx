import { Fragment, useEffect, useRef, useState } from "react";
import type { WorkerState } from "../types";
import { createScene, type SceneHandle } from "../game/scene";
import { SHIRT_COLORS } from "../game/person";
import { chooseBubblePlacement, type BubbleRect } from "../game/bubbleLayout";
import { roomName } from "../workspace";

type VisualWorker = {
  id: string;
  selectId: string;
  name: string;
  character: WorkerState["character"];
  active: boolean;
  colorIndex: number;
  avatarId: string | null;
  avatarKind: WorkerState["avatarKind"];
  avatarPresetId: string;
  busy: boolean;
  temporary: boolean;
  provider: WorkerState["provider"];
  model: string | null;
  role: string | null;
  workspacePath: string;
};

function visualWorkers(workers: WorkerState[], activeId: string | null): VisualWorker[] {
  return workers.flatMap((worker) => {
    const handingOff = Boolean(worker.handoff && !["completed", "failed"].includes(worker.handoff.stage));
    const parent: VisualWorker = {
      id: worker.id,
      selectId: worker.id,
      name: worker.name,
      character: handingOff ? { ...worker.character, activity: "thinking", station: "home", speech: "LLM 交接中…" } : worker.character,
      active: worker.id === activeId,
      colorIndex: worker.colorIndex,
      avatarId: worker.avatarId,
      avatarKind: worker.avatarKind,
      avatarPresetId: worker.avatarPresetId,
      busy: worker.busy,
      temporary: false,
      provider: worker.provider,
      model: worker.model,
      role: worker.persona?.role ?? null,
      workspacePath: worker.workspacePath,
    };
    const subagents: VisualWorker[] = (worker.subagents ?? []).map((agent, index) => ({
      id: `${worker.id}:subagent:${agent.id}`,
      selectId: worker.id,
      name: agent.name,
      character: {
        activity: "working",
        mood: "neutral",
        station: "meeting",
        speech: agent.background ? "背景作業中…" : agent.task,
        bump: 0,
      },
      active: false,
      colorIndex: (worker.colorIndex + index + 1) % SHIRT_COLORS.length,
      avatarId: null,
      avatarKind: "preset",
      avatarPresetId: "classic",
      busy: true,
      temporary: true,
      provider: worker.provider,
      model: worker.model,
      role: null,
      workspacePath: worker.workspacePath,
    }));
    return [parent, ...subagents];
  });
}

type Props = {
  workers: WorkerState[];
  activeId: string | null;
  onSelect(id: string): void;
  onOpenLog?(id: string): void;
  onAvatarError?(id: string, message: string): void;
};

export function GameCanvas({ workers, activeId, onSelect, onOpenLog, onAvatarError }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const bubbleRefs = useRef(new Map<string, HTMLDivElement>());
  const nameRefs = useRef(new Map<string, HTMLDivElement>());
  const identityRefs = useRef(new Map<string, HTMLDivElement>());
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const sceneRef = useRef<SceneHandle | null>(null);
  const latest = useRef<{ workers: WorkerState[]; activeId: string | null }>({
    workers,
    activeId,
  });
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const onAvatarErrorRef = useRef(onAvatarError);
  onAvatarErrorRef.current = onAvatarError;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let cancelled = false;
    let handle: SceneHandle | null = null;

    createScene(host, {
      onPositions: (positions) => {
        const bounds = host.getBoundingClientRect();
        for (const pos of positions) {
          const nameplate = nameRefs.current.get(pos.id);
          if (nameplate) {
            nameplate.style.transform = `translate(-50%, -100%) translate(${bounds.left + pos.x}px, ${bounds.top + pos.y}px)`;
            nameplate.style.opacity = String(pos.opacity);
          }
          const identity = identityRefs.current.get(pos.id);
          if (identity) identity.style.transform = `translate(-50%, 10px) translate(${bounds.left + pos.x}px, ${bounds.top + pos.y}px)`;
        }
        const occupied: BubbleRect[] = [];
        const ordered = [...positions].sort((a, b) =>
          Number(b.id === latest.current.activeId) - Number(a.id === latest.current.activeId),
        );
        for (const pos of ordered) {
          const bubble = bubbleRefs.current.get(pos.id);
          if (!bubble) continue;
          const hidden = bubble.classList.contains("robot-bubble--hidden");
          if (hidden) {
            bubble.style.opacity = "0";
            continue;
          }
          const width = bubble.offsetWidth || 140;
          const height = bubble.offsetHeight || 44;
          const placement = chooseBubblePlacement(
            pos.x,
            pos.y - 20,
            width,
            height,
            bounds.width,
            bounds.height,
            occupied,
          );
          occupied.push(placement.rect);
          bubble.style.transform = `translate(-50%, -100%) translate(${bounds.left + placement.x}px, ${bounds.top + placement.bottom}px)`;
          const compact = bubble.classList.contains("robot-bubble--compact");
          bubble.style.opacity = String(pos.opacity * (compact ? 0.72 : 1));
        }
      },
      onSelect: (id) => onSelectRef.current(id),
      onOpen: (id) => {
        onSelectRef.current(id);
        onOpenLog?.(id);
      },
      onHover: setHoveredId,
      onAvatarError: (id, message) => onAvatarErrorRef.current?.(id, message),
    }).then((h) => {
      if (cancelled) {
        h.destroy();
        return;
      }
      handle = h;
      sceneRef.current = h;
      pushWorkers();
    });

    function pushWorkers() {
      sceneRef.current?.setWorkers(visualWorkers(latest.current.workers, latest.current.activeId));
    }

    return () => {
      cancelled = true;
      handle?.destroy();
      sceneRef.current = null;
    };
  }, []);

  useEffect(() => {
    latest.current = { workers, activeId };
    sceneRef.current?.setWorkers(visualWorkers(workers, activeId));
  }, [workers, activeId]);

  return (
    <>
      <div className="game-host" ref={hostRef} />
      {visualWorkers(workers, activeId).map((w) => {
        const speech = w.character.speech.trim();
        const isActive = w.id === activeId;
        const compact = !isActive;
        const compactSpeech = speech || (w.busy ? "執行中…" : "");
        const source = isActive ? speech : w.busy ? compactSpeech : "";
        const maxSpeech = isActive ? 150 : 38;
        const shown = source.length > maxSpeech ? `…${source.slice(-maxSpeech)}` : source;
        const [shirtColor] = SHIRT_COLORS[w.colorIndex % SHIRT_COLORS.length];
        const accent = `#${shirtColor.toString(16).padStart(6, "0")}`;
        return (
          <Fragment key={w.id}>
            <div
              ref={(el) => {
                if (el) nameRefs.current.set(w.id, el);
                else nameRefs.current.delete(w.id);
              }}
              className={[
                "npc-nameplate",
                isActive ? "npc-nameplate--active" : "",
                w.busy ? "npc-nameplate--busy" : "",
                w.temporary ? "npc-nameplate--subagent" : "",
              ].join(" ")}
              style={{ borderColor: accent }}
            >
              {w.name}
            </div>
            <div
              ref={(el) => {
                if (el) bubbleRefs.current.set(w.id, el);
                else bubbleRefs.current.delete(w.id);
              }}
              className={[
                "robot-bubble",
                shown ? "" : "robot-bubble--hidden",
                isActive ? "" : "robot-bubble--inactive",
                compact ? "robot-bubble--compact" : "",
                !isActive && w.busy ? "robot-bubble--busy" : "",
                w.temporary ? "robot-bubble--subagent" : "",
              ].join(" ")}
            >
              {shown}
            </div>
            {hoveredId === w.id && !w.temporary && (
              <div ref={(element) => {
                if (element) identityRefs.current.set(w.id, element);
                else identityRefs.current.delete(w.id);
              }} className="npc-identity-card">
                <strong>{w.name}</strong>
                <span>{w.character.activity === "working" ? "執行中" : w.busy ? "思考中" : "待命"}</span>
                {w.role && <small className="npc-identity-card__role">{w.role}</small>}
                <small>{w.provider === "claude" ? "Claude Code" : "Codex"} · {w.model || "預設模型"}</small>
                <small>{roomName(w.workspacePath)}</small>
              </div>
            )}
          </Fragment>
        );
      })}
    </>
  );
}
