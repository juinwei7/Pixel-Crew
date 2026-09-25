// 交辦房（與一般部門）Mission 進行中的場景生命力：
// 1) busy 的 NPC 若正在跑工具、但角色狀態還停在自家桌（server 更新時序落差或步驟型
//    session 沒帶站位），由客端依「正在跑的工具」推導該去哪個工作站，讓他走過去互動。
// 2) 討論類步驟（consult/review）沒有工具在跑時，把該步驟負責人最新講的話截成短句
//    當對話泡，使用者不點開日誌也能瞄到討論內容——跟上網查小窗同一種「看得到在幹嘛」精神。
import { stationForTool, type StationKey } from "../stations";
import { stripMarkdown } from "../speechText";

type TurnLike = { items?: Array<{ kind: string; status?: string; name?: string; input?: unknown }> };

/** 最後一個 turn 裡 status=running 的 tool_call（與站點 tooltip 的判定同一套事實來源）。 */
export function runningToolFor(worker: { turns?: TurnLike[] }): { name: string; input: unknown } | null {
  const turns = worker.turns;
  const items = turns?.[turns.length - 1]?.items;
  if (!items) return null;
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item.kind === "tool_call" && item.status === "running") return { name: item.name ?? "", input: item.input };
  }
  return null;
}

/** busy＋有工具在跑＋角色還停在 home → 推導工作站；其他情況回 null（尊重 server 給的站位）。 */
export function missionStationOverride(
  worker: { busy: boolean; turns?: TurnLike[]; character: { station?: string } },
): StationKey | null {
  if (!worker.busy) return null;
  const station = worker.character.station;
  if (station && station !== "home") return null;
  const tool = runningToolFor(worker);
  if (!tool) return null;
  const target = stationForTool(tool.name, tool.input);
  return target === "home" || target === "desk" ? null : target;
}

type ExecutionEventLike = {
  workerId: string;
  event?: { type?: string; text?: string } | null;
};

/** 從 mission 執行事件倒著撈「這位 NPC 最新講的一段話」，截尾當對話泡。
 *  只吃 text_delta（thinking/meta/工具輸出都跳過），跨到別人的發言就停。 */
export function latestMissionSpeech(
  events: ExecutionEventLike[] | undefined,
  workerId: string,
  maxLength = 90,
): string | null {
  if (!events || events.length === 0) return null;
  let collected = "";
  let seenSpeaker = false;
  for (let i = events.length - 1; i >= 0; i--) {
    const entry = events[i];
    const type = entry.event?.type ?? "";
    // 無關事件（思考流、工具輸出、meta）不打斷收集，也不觸發換人判定。
    if (type !== "text_delta" && type !== "turn_end") continue;
    if (entry.workerId !== workerId) {
      if (seenSpeaker) break; // 收集已開始，碰到別人的發言＝這段話收完了
      continue; // 還沒找到目標 NPC 的話，往前跳過別人的
    }
    if (type === "turn_end") {
      if (seenSpeaker) break;
      continue; // 上一輪的結尾，繼續往前找他這輪之前說的話
    }
    seenSpeaker = true;
    collected = (entry.event?.text ?? "") + collected;
    if (collected.length >= maxLength * 3) break; // 已夠截尾，別掃整串
  }
  const text = stripMarkdown(collected).replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.length > maxLength ? `…${text.slice(-maxLength)}` : text;
}
