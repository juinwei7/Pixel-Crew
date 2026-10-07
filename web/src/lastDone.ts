import { t } from "./i18n";
import { stripMarkdown } from "./speechText";
import type { WorkerState } from "./types";

/* 閒置名牌的第二行：「12 分前・寫完 README」。
   回合本身沒有時間戳；NPC 閒置時 character.speechAt 是最後一個事件（收尾那段文字）的
   server 時間，重整重播也保留——拿它當「完成時間」。摘要取那個回合的指令首行，壓到約 12 字。 */

/** 相對時間（只到分鐘粒度，名牌每 30 秒重畫一次就夠）。和 formatElapsed 一樣吃秒數。 */
export function formatAgo(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return t("剛剛");
  const minutes = Math.floor(s / 60);
  if (minutes < 60) return t("{n} 分前", { n: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("{n} 小時前", { n: hours });
  return t("{n} 天前", { n: Math.floor(hours / 24) });
}

/** 指令首行壓成短摘要：中日韓約 12 字；純英數文字字較窄，放寬到 20。 */
export function shortSummary(text: string, max = 12): string {
  const line = stripMarkdown(text).split(/\r?\n/).map((part) => part.trim()).find(Boolean) ?? "";
  const flat = line.replace(/\s+/g, " ");
  const chars = Array.from(flat);
  const limit = /^[\x20-\x7e]*$/.test(flat) ? Math.round(max * 5 / 3) : max;
  return chars.length > limit ? `${chars.slice(0, limit).join("").trimEnd()}…` : flat;
}

/**
 * 閒置 NPC 名牌第二行；忙碌、沒有完成過的回合、最近一回合失敗、或沒有時間戳時回 null。
 * 通知回合（沒有 items，例如「循環問你」）與系統回合（換腦等）不算「完成的工作」，往前找。
 */
export function lastDoneLine(worker: Pick<WorkerState, "busy" | "turns" | "character">, nowMs: number): string | null {
  if (worker.busy) return null;
  const at = worker.character.speechAt;
  if (typeof at !== "number" || !Number.isFinite(at)) return null;
  for (let i = worker.turns.length - 1; i >= 0; i--) {
    const turn = worker.turns[i];
    if (turn.system || turn.items.length === 0) continue;
    if (turn.status !== "done") return null;
    const what = shortSummary(turn.command);
    const ago = formatAgo((nowMs - at) / 1000);
    return what ? t("{ago}・{what}", { ago, what }) : ago;
  }
  return null;
}
