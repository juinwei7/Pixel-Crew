// 交辦房（與一般部門）Mission 進行中的場景生命力：
// 1) busy 的 NPC 若正在跑工具、但角色狀態還停在自家桌（server 更新時序落差或步驟型
//    session 沒帶站位），由客端依「正在跑的工具」推導該去哪個工作站，讓他走過去互動。
// 2) 討論類步驟（consult/review）沒有工具在跑時，把該步驟負責人最新講的話截成短句
//    當對話泡，使用者不點開日誌也能瞄到討論內容——跟上網查小窗同一種「看得到在幹嘛」精神。
import { stationForTool, type StationKey } from "../stations";
import { stripMarkdown } from "../speechText";
import { friendlyToolSpeech, webQueryFromInput } from "../workerState";
import { t } from "../i18n";
import type { CharacterState } from "../types";

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

type ExecutionEventLike = {
  workerId: string;
  event?: { type?: string; text?: string; name?: string; input?: unknown; at?: number } | null;
};

/** Mission 步驟的工具站位：Mission 走獨立的 mission runner，工具事件「只」進 mission.executionEvents，
 *  完全不會進 worker 自己的 turns/character（所以 worker.character.station 永遠停在 home）。
 *  從尾端倒著找這位 NPC「本輪」最後一次 tool_call_start → 該工具的站位；碰到他的 user_message／
 *  turn_end／error（輪次邊界）就停、回 null。語意對齊 workerState：工具結果回來後仍留在站點，
 *  直到該輪結束才回座——工具 start/result 幾乎同一刻到達，若只看「執行中」會瞬間被拉回 home、
 *  NPC 根本來不及走過去。 */
export function missionToolStation(events: ExecutionEventLike[] | undefined, workerId: string): StationKey | null {
  const tool = missionCurrentTool(events, workerId);
  return tool ? stationForTool(tool.name, tool.input) : null;
}

/** missionToolStation 的工具本體（同一套「本輪最後一次 tool_call_start」語意）。 */
export function missionCurrentTool(
  events: ExecutionEventLike[] | undefined,
  workerId: string,
): { name: string; input: unknown; at?: number } | null {
  if (!events) return null;
  for (let i = events.length - 1; i >= 0; i--) {
    const entry = events[i];
    if (entry.workerId !== workerId) continue;
    const type = entry.event?.type;
    if (type === "user_message" || type === "turn_end" || type === "error") return null;
    if (type === "tool_call_start") return { name: entry.event?.name ?? "", input: entry.event?.input, at: entry.event?.at };
  }
  return null;
}

/** 這位 NPC 在 Mission「本輪」當下在幹嘛的一句話（對話泡／工作小窗用）：
 *  倒著看他本輪最新的一個「有內容」事件——tool_call_start → friendlyToolSpeech 短句（跟一般對話路徑同一套）；
 *  text_delta → 他最新講的話；只有 user_message（剛開輪、還在想）→「思考中」。
 *  碰到 turn_end／error（本輪已結束）或完全沒有他的事件 → null。 */
export function missionActivitySpeech(
  events: ExecutionEventLike[] | undefined,
  workerId: string,
  maxLength = 90,
): { speech: string; at?: number; tool: { name: string; input: unknown } | null } | null {
  if (!events) return null;
  for (let i = events.length - 1; i >= 0; i--) {
    const entry = events[i];
    if (entry.workerId !== workerId) continue;
    const type = entry.event?.type;
    if (type === "turn_end" || type === "error") return null;
    if (type === "tool_call_start") {
      const name = entry.event?.name ?? "";
      const input = entry.event?.input;
      return { speech: friendlyToolSpeech(name, input), at: entry.event?.at, tool: { name, input } };
    }
    if (type === "text_delta") {
      const speech = latestMissionSpeech(events, workerId, maxLength);
      if (speech) return { speech, at: entry.event?.at, tool: null };
      continue; // 只有空白的 delta，繼續往前找
    }
    if (type === "user_message") return { speech: t("思考中"), at: entry.event?.at, tool: null };
  }
  return null;
}

/** busy＋有工具在跑（或 Mission 本輪用過工具）＋角色還停在 home → 推導工作站；其他情況回 null（尊重 server 給的站位）。
 *  executionEvents：該 NPC 所屬進行中 Mission 的 mission.executionEvents（見 missionToolStation）。 */
export function missionStationOverride(
  worker: { id?: string; busy: boolean; turns?: TurnLike[]; character: { station?: string } },
  executionEvents?: ExecutionEventLike[],
): StationKey | null {
  if (!worker.busy) return null;
  const station = worker.character.station;
  if (station && station !== "home") return null;
  const tool = runningToolFor(worker);
  const target = tool
    ? stationForTool(tool.name, tool.input)
    : worker.id ? missionToolStation(executionEvents, worker.id) : null;
  return !target || target === "home" || target === "desk" ? null : target;
}

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

/** Mission 期間這位 NPC 該顯示的角色狀態（站位＋對話泡）；null＝不介入、沿用 worker.character。
 *  Mission 走獨立 runner，worker.character（含 speech）整場都停在他「自己上次聊天」的狀態，
 *  所以 busy 且屬於進行中 Mission 時，泡泡一律改吃 mission.executionEvents，絕不顯示舊的私聊字：
 *  - 走到工具站（stationOverride）→ 當下工具的 friendlyToolSpeech 短句（說話了就換成最新發言）。
 *  - 沒在站點但本輪有活動 → 同上的當下活動；討論類步驟負責人 → 最新發言（舊 missionTalking 行為）。
 *  - 本輪已結束／還沒輪到他 → 他最後一段 Mission 發言，沒有就「執行中…」。
 *  非 Mission 的 NPC：只保留舊的「自己工具在跑但角色還停 home」站位覆寫，speech 照舊。 */
export function missionCharacter(
  worker: { id: string; busy: boolean; turns?: TurnLike[]; character: CharacterState },
  mission: { executionEvents?: ExecutionEventLike[] } | null | undefined,
  isAssignee: boolean,
): CharacterState | null {
  const events = mission?.executionEvents;
  const stationOverride = missionStationOverride(worker, events);
  // 自己的對話正在跑工具（非 Mission 路徑）：worker 自己的串流就是當下的，只補站位。
  if (!mission || !worker.busy || runningToolFor(worker)) {
    return stationOverride ? { ...worker.character, station: stationOverride } : null;
  }
  const now = missionActivitySpeech(events, worker.id);
  if (stationOverride) {
    const tool = now?.tool ?? missionCurrentTool(events, worker.id);
    return {
      ...worker.character,
      activity: "working",
      mood: "neutral",
      station: stationOverride,
      speech: now?.speech ?? (tool ? friendlyToolSpeech(tool.name, tool.input) : t("執行中…")),
      speechAt: now?.at ?? worker.character.speechAt,
      webQuery: stationOverride === "web" && tool ? webQueryFromInput(tool.input) : undefined,
    };
  }
  if (now) {
    return {
      ...worker.character,
      activity: now.tool ? "working" : "thinking",
      mood: "neutral",
      speech: now.speech,
      speechAt: now.at ?? worker.character.speechAt,
      webQuery: undefined,
    };
  }
  const lastWords = latestMissionSpeech(events, worker.id);
  if (lastWords && isAssignee) return { ...worker.character, activity: "thinking", speech: lastWords, webQuery: undefined };
  return { ...worker.character, speech: lastWords ?? t("執行中…"), webQuery: undefined };
}
