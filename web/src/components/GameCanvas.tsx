import { Fragment, useEffect, useRef } from "react";
import type { WorkerState } from "../types";
import { createScene, type SceneHandle } from "../game/scene";
import { SHIRT_COLORS } from "../game/person";

type VisualWorker = {
  id: string;
  selectId: string;
  name: string;
  character: WorkerState["character"];
  active: boolean;
  colorIndex: number;
  busy: boolean;
  temporary: boolean;
};

function visualWorkers(workers: WorkerState[], activeId: string | null): VisualWorker[] {
  return workers.flatMap((worker) => {
    const parent: VisualWorker = {
      id: worker.id,
      selectId: worker.id,
      name: worker.name,
      character: worker.character,
      active: worker.id === activeId,
      colorIndex: worker.colorIndex,
      busy: worker.busy,
      temporary: false,
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
      busy: true,
      temporary: true,
    }));
    return [parent, ...subagents];
  });
}

type Props = {
  workers: WorkerState[];
  activeId: string | null;
  onSelect(id: string): void;
};

export function GameCanvas({ workers, activeId, onSelect }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const bubbleRefs = useRef(new Map<string, HTMLDivElement>());
  const nameRefs = useRef(new Map<string, HTMLDivElement>());
  const sceneRef = useRef<SceneHandle | null>(null);
  const latest = useRef<{ workers: WorkerState[]; activeId: string | null }>({
    workers,
    activeId,
  });
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let cancelled = false;
    let handle: SceneHandle | null = null;

    createScene(host, {
      onPositions: (positions) => {
        const bounds = host.getBoundingClientRect();
        for (const pos of positions) {
          const bubble = bubbleRefs.current.get(pos.id);
          if (bubble) {
            bubble.style.transform = `translate(-50%, -100%) translate(${bounds.left + pos.x}px, ${bounds.top + pos.y - 20}px)`;
          }
          const nameplate = nameRefs.current.get(pos.id);
          if (nameplate) {
            nameplate.style.transform = `translate(-50%, -100%) translate(${bounds.left + pos.x}px, ${bounds.top + pos.y}px)`;
          }
        }
      },
      onSelect: (id) => onSelectRef.current(id),
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
        const maxSpeech = isActive ? 150 : 72;
        const shown = speech.length > maxSpeech ? `…${speech.slice(-maxSpeech)}` : speech;
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
                !isActive && w.busy ? "robot-bubble--busy" : "",
                w.temporary ? "robot-bubble--subagent" : "",
              ].join(" ")}
            >
              {shown}
            </div>
          </Fragment>
        );
      })}
    </>
  );
}
