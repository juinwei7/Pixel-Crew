import type { WorkerState } from "../types";
import { SHIRT_COLORS } from "../game/person";

type Props = {
  workers: WorkerState[];
  activeId: string | null;
  onSelect(id: string): void;
  onCreate(): void;
  onClose(id: string): void;
};

function shirtColor(index: number): string {
  const [color] = SHIRT_COLORS[index % SHIRT_COLORS.length];
  return `#${color.toString(16).padStart(6, "0")}`;
}

export function WorkerTabs({ workers, activeId, onSelect, onCreate, onClose }: Props) {
  return (
    <div className="worker-tabs">
      {workers.map((w) => (
        <div
          key={w.id}
          className={`worker-tab ${w.id === activeId ? "worker-tab--active" : ""}`}
          onClick={() => onSelect(w.id)}
        >
          <span
            className={`worker-tab__dot ${w.busy ? "worker-tab__dot--busy" : ""}`}
            style={{ background: shirtColor(w.colorIndex) }}
          />
          <span className="worker-tab__name">{w.name}</span>
          {w.model && <span className="worker-tab__model">{w.model}</span>}
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
      <button className="worker-tabs__add" title="新增工人" onClick={onCreate}>
        ＋
      </button>
    </div>
  );
}
