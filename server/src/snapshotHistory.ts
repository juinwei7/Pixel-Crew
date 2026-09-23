import type { RunnerEvent } from "./claudeRunner.js";

// 初始 snapshot 瘦身：**保留完整訊息筆數**（日誌照樣看得到），只把單筆超大的工具
// 輸出/輸入等內容截短。真正把歷史脹到十幾 MB 的是少數幾筆巨大的工具輸出（單筆可達
// 200KB+ 的檔案內容/截圖等），不是訊息「數量」。截短後手機收得動，完整內容仍保存在
// 本機 SQLite。另設一個很寬鬆的筆數上限當保險絲，避免極端情況整包無界成長。
export const SNAPSHOT_MAX_EVENTS = 800;        // 每 worker 最多送這麼多筆（對齊 turn 邊界）
export const SNAPSHOT_MAX_FIELD_CHARS = 6_000; // 單一欄位序列化長度上限，超過就截短
// 裁切時「每個 NPC 獨立」至少保留最近這麼多個完整 turn（＝使用者說的「最新的兩個結果」）。
// 保證切點一定落在某個 user_message 上，前端永遠重建得出 turn、日誌不會整個變空白。
export const SNAPSHOT_MIN_TURNS = 2;

function clampField(value: unknown): unknown {
  let s: string;
  try {
    s = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    return value;
  }
  if (s == null || s.length <= SNAPSHOT_MAX_FIELD_CHARS) return value;
  return s.slice(0, SNAPSHOT_MAX_FIELD_CHARS) + `…（省略 ${s.length - SNAPSHOT_MAX_FIELD_CHARS} 字；完整內容保存於本機）`;
}

// 只截「內容型」的大欄位，事件的結構與型別（type/id/name…）保持不變，前端照常渲染。
export function trimEventForSnapshot(ev: RunnerEvent): RunnerEvent {
  switch (ev.type) {
    case "tool_call_result":
      return { ...ev, output: clampField(ev.output) };
    case "tool_call_start":
      return { ...ev, input: clampField(ev.input) };
    case "tool_call_output_delta":
      return ev.delta.length > SNAPSHOT_MAX_FIELD_CHARS ? { ...ev, delta: String(clampField(ev.delta)) } : ev;
    case "text_delta":
    case "thinking_delta":
      return ev.text.length > SNAPSHOT_MAX_FIELD_CHARS ? { ...ev, text: String(clampField(ev.text)) } : ev;
    default:
      return ev;
  }
}

// 每個 NPC 獨立計算。歷史超過視窗上限就裁切，但**絕不從半截 turn 開頭切**——若切出來的
// 開頭沒有 user_message，前端會把這些「孤兒事件」全部略過（見 web/src/workerState.ts 的
// text_delta/thinking_delta：沒有進行中的 turn 就整個 no-op），日誌就整個變空白。這正是
// 「日誌越長反而消失」的元兇：單一超長 turn 的 event 數 > 視窗上限時，turn 的 user_message
// 被推出視窗，只剩孤兒事件。做法：至少保留「最新的 SNAPSHOT_MIN_TURNS 個完整 turn」，且
// 切點一定落在某個 user_message 上，保證前端永遠重建得出 turn、日誌不會空。完整內容仍在
// 本機 SQLite，需要時前端可另外抓。
export function snapshotHistory(history: RunnerEvent[]): RunnerEvent[] {
  const n = history.length;
  if (n <= SNAPSHOT_MAX_EVENTS) return history.map(trimEventForSnapshot);
  // 收集所有 turn 邊界（user_message 的位置）。
  const turnStarts: number[] = [];
  for (let i = 0; i < n; i++) if (history[i]?.type === "user_message") turnStarts.push(i);
  let start: number;
  if (turnStarts.length === 0) {
    // 完全沒有 turn 邊界（只有 meta/text 之類）→ 保留尾段，別無更好選擇。
    start = n - SNAPSHOT_MAX_EVENTS;
  } else {
    // (a) 尺寸視窗：最後 SNAPSHOT_MAX_EVENTS 筆，對齊到視窗內第一個 turn 開頭。
    const windowStart = n - SNAPSHOT_MAX_EVENTS;
    const alignedInWindow = turnStarts.find((i) => i >= windowStart);
    // (b) 最近 N 個完整 turn 的起點（保證至少這麼多個完整結果）。
    const minTurnsStart = turnStarts[Math.max(0, turnStarts.length - SNAPSHOT_MIN_TURNS)];
    // 取兩者中「較早」的：視窗內有 turn 開頭就用它（通常保留更多 turn）；視窗整段都是
    // 單一超長 turn 的孤兒（alignedInWindow 為 undefined）時退回最近 N 個 turn 的起點。
    // 兩個候選都是 user_message 的索引，所以 start 一定是 turn 邊界，日誌不會空白。
    start = alignedInWindow === undefined ? minTurnsStart : Math.min(alignedInWindow, minTurnsStart);
  }
  return history.slice(start).map(trimEventForSnapshot);
}
