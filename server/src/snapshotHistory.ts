import type { RunnerEvent } from "./claudeRunner.js";
import { t } from "./i18n.js";

// 初始 snapshot 瘦身：**保留完整訊息筆數**（日誌照樣看得到），只把單筆超大的工具
// 輸出/輸入等內容截短。真正把歷史脹到十幾 MB 的是少數幾筆巨大的工具輸出（單筆可達
// 200KB+ 的檔案內容/截圖等），不是訊息「數量」。截短後手機收得動，完整內容仍保存在
// 本機 SQLite。另設一個很寬鬆的筆數上限當保險絲，避免極端情況整包無界成長。
export const SNAPSHOT_MAX_EVENTS = 800;        // 每 worker 最多送這麼多筆（對齊 turn 邊界）
export const SNAPSHOT_MAX_FIELD_CHARS = 6_000; // 單一欄位序列化長度上限，超過就截短
// 裁切時「每個 NPC 獨立」至少保留最近這麼多個**真實結果** turn（＝使用者說的「最新的兩個結果」）。
// 關鍵：只數「非系統」的 turn（見 minRealTurnsStart）。換腦一次會連插數張 system 卡（換腦宣告／
// 蒸餾心法／換腦完成），若把它們也算進這個名額，一次換腦就能把使用者真正的工作結果全擠出 snapshot
// ＝重啟後只看得到換腦卡、前面日誌像被整個蓋掉（owner 回報）。保證切點一定落在某個 user_message 上，
// 前端永遠重建得出 turn、日誌不會整個變空白。
export const SNAPSHOT_MIN_TURNS = 2;
// 硬上限。SNAPSHOT_MAX_EVENTS 是「視窗」，但為了不從半截 turn 開頭切，起點會往前退到
// turn 邊界，所以實際筆數會溢出視窗——溢出到「整段歷史照送」就等於上限失效（單一超長
// turn 或連續幾個長 turn 都會走到那裡），初始 snapshot 又會回到十幾 MB。這是那個往前退
// 的天花板：超過就連「保留 SNAPSHOT_MIN_TURNS 個完整 turn」都要讓步。
export const SNAPSHOT_HARD_MAX_EVENTS = SNAPSHOT_MAX_EVENTS * 2;

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

// 「真實結果」floor：從最新往回數，只把**非系統**的 turn 算進 SNAPSHOT_MIN_TURNS，回傳「往回第 N
// 個真實 turn」的起點索引。換腦卡（system/notice）不佔名額，只會附在這個起點之後一起送出。這樣
// 一次換腦插再多系統卡，使用者最近的 N 個真實工作結果都保證留在 snapshot 裡。不足 N 個真實 turn
// 時退回最早的 turn 起點（保留全部 turn）。回傳值一定是某個 user_message 的索引。
function minRealTurnsStart(history: RunnerEvent[], turnStarts: number[]): number {
  let real = 0;
  for (let k = turnStarts.length - 1; k >= 0; k--) {
    const ev = history[turnStarts[k]]!;
    const isSystemCard = ev.type === "user_message" && (ev.system === true || ev.notice === true);
    if (!isSystemCard) real += 1;
    if (real >= SNAPSHOT_MIN_TURNS) return turnStarts[k]!;
  }
  return turnStarts[0]!;
}

// 每個 NPC 獨立計算。歷史超過視窗上限就裁切，但**絕不從半截 turn 開頭切**——若切出來的
// 開頭沒有 user_message，前端會把這些「孤兒事件」全部略過（見 web/src/workerState.ts 的
// text_delta/thinking_delta：沒有進行中的 turn 就整個 no-op），日誌就整個變空白。這正是
// 「日誌越長反而消失」的元兇：單一超長 turn 的 event 數 > 視窗上限時，turn 的 user_message
// 被推出視窗，只剩孤兒事件。做法：至少保留「最新的 SNAPSHOT_MIN_TURNS 個真實結果 turn」（換腦
// 系統卡不佔名額），且切點一定落在某個 user_message 上，保證前端永遠重建得出 turn、日誌不會空。
// 完整內容仍在本機 SQLite，需要時前端可另外抓。
export function snapshotHistory(history: RunnerEvent[]): RunnerEvent[] {
  const n = history.length;
  if (n <= SNAPSHOT_MAX_EVENTS) return history.map(trimEventForSnapshot);
  // 收集所有 turn 邊界（user_message 的位置）。
  const turnStarts: number[] = [];
  for (let i = 0; i < n; i++) if (history[i]?.type === "user_message") turnStarts.push(i);
  let start: number;
  if (turnStarts.length === 0) {
    // 完全沒有 turn 邊界：這個 turn 的 user_message 已被推出保留上限（重啟後從 SQLite 載入的
    // 歷史就可能如此）。只送尾段的話前端一個 turn 都開不出來、日誌整片空白，所以補一張佔位的
    // 開頭卡，讓尾段事件有 turn 可掛。
    const tail = history.slice(n - (SNAPSHOT_MAX_EVENTS - 1));
    const opener: RunnerEvent = { type: "user_message", text: t("（這個回合開頭的訊息已超出保留上限，以下是後段紀錄）"), at: tail[0]?.at };
    return [opener, ...tail].map(trimEventForSnapshot);
  } else {
    // (a) 尺寸視窗：最後 SNAPSHOT_MAX_EVENTS 筆，對齊到視窗內第一個 turn 開頭。
    const windowStart = n - SNAPSHOT_MAX_EVENTS;
    const alignedInWindow = turnStarts.find((i) => i >= windowStart);
    // (b) 最近 N 個「真實結果」turn 的起點（換腦系統卡不佔名額，保證真實結果不被擠出）。
    const minTurnsStart = minRealTurnsStart(history, turnStarts);
    // 取兩者中「較早」的：視窗內有 turn 開頭就用它（通常保留更多 turn）；視窗整段都是
    // 單一超長 turn 的孤兒（alignedInWindow 為 undefined）、或視窗內的 turn 都是換腦系統卡時，
    // 退回最近 N 個真實結果的起點。兩個候選都是 user_message 的索引，start 一定落在 turn 邊界。
    start = alignedInWindow === undefined ? minTurnsStart : Math.min(alignedInWindow, minTurnsStart);
    if (n - start > SNAPSHOT_HARD_MAX_EVENTS) {
      // 退到 turn 邊界後還是爆掉硬上限。先試「能塞進上限的最早 turn 邊界」（仍是完整 turn）。
      const fitting = turnStarts.find((i) => n - i <= SNAPSHOT_HARD_MAX_EVENTS);
      if (fitting !== undefined) {
        start = fitting;
      } else {
        // 連最後一個 turn 自己都超過上限（單一超長 turn）。此時「完整 turn」和「有界」不可
        // 兼得，取前端真正需要的那一半：turn 的 user_message ＋該 turn 的尾段。前端只要看到
        // user_message 就開得出 turn，中間少幾筆不會讓日誌整片空白（見上面的說明）。
        const lastTurnStart = turnStarts[turnStarts.length - 1];
        const tail = history.slice(n - (SNAPSHOT_HARD_MAX_EVENTS - 1));
        return [history[lastTurnStart], ...tail].map(trimEventForSnapshot);
      }
    }
  }
  return history.slice(start).map(trimEventForSnapshot);
}

// 保留歷史的裁切（record() 每筆事件都會走到）：從最舊的開始丟，但還開著的那個 turn 的
// user_message 不能跟著丟——單一 turn 超過上限時它會被推出去，snapshot 只剩孤兒事件、前端
// 開不出 turn、日誌一片空白。被切掉的範圍裡最後一個 turn 若還沒收尾（之後沒有 turn_end/error），
// 而保留段的開頭又是它的中段事件，就把它的 user_message 釘在開頭、改丟後面那一筆中段事件，
// 長度仍是 max。notice 不是 turn 開頭（不會有 turn_end），不算數。
export function trimRetainedHistory(history: RunnerEvent[], max: number): void {
  const excess = history.length - max;
  if (excess <= 0) return;
  const head = history[excess];
  const headIsBoundary = !head || head.type === "turn_end" || head.type === "error" || (head.type === "user_message" && !head.notice);
  let opener: RunnerEvent | null = null;
  if (!headIsBoundary) {
    for (let index = excess - 1; index >= 0; index--) {
      const event = history[index]!;
      if (event.type === "turn_end" || event.type === "error") break;
      if (event.type === "user_message" && !event.notice) { opener = event; break; }
    }
  }
  if (opener) history.splice(0, excess + 1, opener);
  else history.splice(0, excess);
}

// 送前端前把「連續的文字 delta」合併成一則（text_delta 接 text_delta、thinking_delta 接
// thinking_delta）。前端 reducer（web/src/workerState.ts）本來就把連續同型 delta 串接到同一個
// 開著的 item，合併後重播出來的畫面完全相同，但 payload 少了每筆的 {"type":…,"at":…} 外殼、
// 重播次數也從數百降到個位數（每次 reducer 都會複製 turn.items，原本是 O(n²)）。
// 規則：
//  - 只合併「相鄰且同型」的 text/thinking delta；中間夾任何其他事件（tool_call_start 會關掉
//    openTextKey）就斷開，順序與分段完全保留。
//  - 合併後長度不得超過 maxChars（預設＝SNAPSHOT_MAX_FIELD_CHARS），避免合併後的大段被
//    trimEventForSnapshot 截短——那就改變呈現內容了。超過就另起一則（前端仍會接回同一段）。
//  - at 取最後一筆（前端 speechAt＝最後一個 delta 的 at，重播結果一致）。
//  - 不改動輸入陣列與其中的事件物件。
export function coalesceDeltaEvents(events: RunnerEvent[], maxChars = SNAPSHOT_MAX_FIELD_CHARS): RunnerEvent[] {
  const out: RunnerEvent[] = [];
  let merged = false; // out 最後一筆是否為本函式新建（可就地改寫）
  for (const ev of events) {
    const prev = out[out.length - 1];
    if (
      (ev.type === "text_delta" || ev.type === "thinking_delta")
      && prev?.type === ev.type
      && prev.text.length + ev.text.length <= maxChars
    ) {
      const text = prev.text + ev.text;
      const at = ev.at ?? prev.at;
      if (merged) {
        prev.text = text;
        if (at !== undefined) prev.at = at;
      } else {
        const next = { ...prev, text } as typeof prev;
        if (at !== undefined) next.at = at;
        out[out.length - 1] = next;
        merged = true;
      }
      continue;
    }
    out.push(ev);
    merged = false;
  }
  return out;
}
