import { useEffect, useRef } from "react";
import type { WorkerState } from "../types";
import { createScene, type SceneHandle } from "../game/scene";

type Props = {
  workers: WorkerState[];
  activeId: string | null;
  onSelect(id: string): void;
};

export function GameCanvas({ workers, activeId, onSelect }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const bubbleRefs = useRef(new Map<string, HTMLDivElement>());
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
        for (const pos of positions) {
          const bubble = bubbleRefs.current.get(pos.id);
          if (bubble) {
            bubble.style.transform = `translate(-50%, -100%) translate(${pos.x}px, ${pos.y}px)`;
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
      sceneRef.current?.setWorkers(
        latest.current.workers.map((w) => ({
          id: w.id,
          character: w.character,
          active: w.id === latest.current.activeId,
          colorIndex: w.colorIndex,
        })),
      );
    }

    return () => {
      cancelled = true;
      handle?.destroy();
      sceneRef.current = null;
    };
  }, []);

  useEffect(() => {
    latest.current = { workers, activeId };
    sceneRef.current?.setWorkers(
      workers.map((w) => ({
        id: w.id,
        character: w.character,
        active: w.id === activeId,
        colorIndex: w.colorIndex,
      })),
    );
  }, [workers, activeId]);

  return (
    <>
      <div className="game-host" ref={hostRef} />
      {workers.map((w) => {
        const speech = w.character.speech.trim();
        const shown = speech.length > 150 ? `…${speech.slice(-150)}` : speech;
        const isActive = w.id === activeId;
        return (
          <div
            key={w.id}
            ref={(el) => {
              if (el) bubbleRefs.current.set(w.id, el);
              else bubbleRefs.current.delete(w.id);
            }}
            className={[
              "robot-bubble",
              shown ? "" : "robot-bubble--hidden",
              isActive ? "" : "robot-bubble--inactive",
            ].join(" ")}
          >
            {shown}
          </div>
        );
      })}
    </>
  );
}
