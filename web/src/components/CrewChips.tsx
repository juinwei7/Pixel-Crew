import { SHIRT_COLORS } from "../game/person";
import { workerAttention } from "../crew";
import { t } from "../i18n";
import type { WorkerState } from "../types";
import { roomName } from "../workspace";

/* 手機換 NPC 的那一排橫向 chip。

   像素模式（頂部的隊員列）與專業模式（報告標題列）用的是同一個元件。以前
   專業模式是一個 <select>：看不到「現在有誰、誰在等你」，換人要先展開原生
   選單再挑——同一件事在兩個模式長得完全不一樣。

   這裡只負責畫，不管資料怎麼來：像素模式傳的是隊員列的排序，專業模式傳的
   是目前工作位置的成員。有誰未讀由呼叫端決定（專業模式的「未讀」是相對於
   那個 pane 看到哪一回合，像素模式沒有這個概念）。 */

export function shirtColor(index: number): string {
  const [color] = SHIRT_COLORS[index % SHIRT_COLORS.length];
  return `#${color.toString(16).padStart(6, "0")}`;
}

type Props = {
  workers: WorkerState[];
  activeId: string | null;
  onSelect(id: string): void;
  /** 預設「人員」；專業模式講的是「工作對象」。 */
  label?: string;
  /** 回傳 true 的 NPC 會多一個未讀點。 */
  unread?(worker: WorkerState): boolean;
};

export function CrewChips({ workers, activeId, onSelect, label, unread }: Props) {
  return (
    <div className="crew-strip" role="tablist" aria-label={label ?? t("人員")}>
      {workers.map((worker) => {
        const status = workerAttention(worker);
        const hasUnread = unread?.(worker) ?? false;
        return (
          <button
            key={worker.id}
            type="button"
            role="tab"
            aria-selected={worker.id === activeId}
            className={`crew-strip__chip${worker.id === activeId ? " crew-strip__chip--active" : ""}${hasUnread ? " crew-strip__chip--unread" : ""}`}
            title={`${worker.name} · ${roomName(worker.workspacePath)}`}
            onClick={() => onSelect(worker.id)}
          >
            <span className="crew-row__avatar" style={{ background: shirtColor(worker.colorIndex) }}>{worker.avatarKind === "custom" ? "◆" : ""}</span>
            <span className="crew-strip__name">{worker.name}</span>
            <span className={`crew-strip__status crew-strip__status--${status}`} aria-hidden="true" />
          </button>
        );
      })}
    </div>
  );
}
