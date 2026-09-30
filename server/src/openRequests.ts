// 未結案使用者請求帳本（Open User Requests Ledger）
//
// 病因（見《換腦遺失使用者任務-證明與改善設計》）：使用者在自動循環中臨時插的請求，跑完
// 一回合後有兩個遺失點——(A) 教練 prompt 只把它當「又一個無標記回合」，受「延續原主線、
// 往上爬一階」偏誤影響而被當旁支丟棄；(B) 換腦交接摘要只看最近 6 回合、無專屬欄位、goal
// 又被循環的教練 prompt 劫持。
//
// 對策（借鑑影片 cortxos/SAMS「first message carries this history」）：把「真人請求」原文
// 存進一條 durable 帳本（key＝workerId），在上述兩個遺失點都「原文注入」——教練 prompt 明令
// 優先承接、換腦交接逐字照搬——直到教練真正處理完才標記結案。
//
// 這裡只放純函式＋檔案式 store（比照 workerAutopilot.ts 的 retro store）；IO 接線在 index.ts。
import fs from "node:fs";
import path from "node:path";
import { t } from "./i18n.js";

/** 一筆未結案的真人請求。text 為原文（截斷但不摘要），status 只有 open/resolved 兩態。 */
export type OpenUserRequest = {
  id: string;
  text: string;
  at: number;
  status: "open" | "resolved";
  resolvedAt?: number;
};

/** 單一 worker 的帳本上限：open 太多代表積壓，保留最新、最舊的 open 先降級（見 appendOpenRequest）。 */
export const MAX_OPEN_REQUESTS_PER_WORKER = 12;
/** 請求原文上限：夠承載一段完整訴求，又不至於灌爆 prompt。 */
export const OPEN_REQUEST_TEXT_MAX = 2_000;

function bounded(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

/** 逐條驗證還原：id/text 缺一整條丟棄、status 非法歸 open、at 非數字歸 0。 */
export function normalizeOpenRequests(raw: unknown): Record<string, OpenUserRequest[]> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, OpenUserRequest[]> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!key || typeof key !== "string" || !Array.isArray(value)) continue;
    const list: OpenUserRequest[] = [];
    for (const item of value) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const entry = item as Record<string, unknown>;
      const id = bounded(entry.id, 200);
      const text = bounded(entry.text, OPEN_REQUEST_TEXT_MAX);
      if (!id || !text) continue;
      const at = typeof entry.at === "number" && Number.isFinite(entry.at) ? entry.at : 0;
      const status = entry.status === "resolved" ? "resolved" : "open";
      const resolvedAt = typeof entry.resolvedAt === "number" && Number.isFinite(entry.resolvedAt) ? entry.resolvedAt : undefined;
      list.push({ id, text, at, status, ...(status === "resolved" && resolvedAt != null ? { resolvedAt } : {}) });
    }
    if (list.length) out[key] = list.slice(-MAX_OPEN_REQUESTS_PER_WORKER * 2);
  }
  return out;
}

/**
 * 記一筆真人請求。空白略過；與該 worker 最近一筆 open 原文相同則略過（防同一則重複洗版）；
 * 若 open 數超過上限，把最舊的 open 標記 resolved（積壓降級，避免帳本無限膨脹）。回傳是否寫入。
 */
export function appendOpenRequest(
  ledger: Record<string, OpenUserRequest[]>,
  workerId: string,
  text: unknown,
  at: number,
  id: string,
): boolean {
  const body = bounded(text, OPEN_REQUEST_TEXT_MAX);
  const requestId = bounded(id, 200);
  if (!body || !requestId) return false;
  const list = ledger[workerId] ?? [];
  const lastOpen = [...list].reverse().find((entry) => entry.status === "open");
  if (lastOpen && lastOpen.text === body) return false;
  list.push({ id: requestId, text: body, at, status: "open" });
  // 積壓降級：open 超過上限時，把最舊的多餘 open 標 resolved（時間序）。
  const open = list.filter((entry) => entry.status === "open");
  if (open.length > MAX_OPEN_REQUESTS_PER_WORKER) {
    const demote = open.slice(0, open.length - MAX_OPEN_REQUESTS_PER_WORKER);
    for (const entry of demote) { entry.status = "resolved"; entry.resolvedAt = at; }
  }
  ledger[workerId] = list.slice(-MAX_OPEN_REQUESTS_PER_WORKER * 2);
  return true;
}

/** 依 id 標記結案（教練回報處理完、或人工確認）。回傳實際結案的筆數。 */
export function resolveOpenRequests(
  ledger: Record<string, OpenUserRequest[]>,
  workerId: string,
  ids: unknown,
  at: number,
): number {
  const wanted = new Set((Array.isArray(ids) ? ids : []).map((id) => bounded(id, 200)).filter(Boolean));
  if (!wanted.size) return 0;
  const list = ledger[workerId];
  if (!list) return 0;
  let count = 0;
  for (const entry of list) {
    if (entry.status === "open" && wanted.has(entry.id)) {
      entry.status = "resolved";
      entry.resolvedAt = at;
      count += 1;
    }
  }
  return count;
}

/** 只回傳仍 open 的請求（時間序，最舊在前）。 */
export function listOpenRequests(ledger: Record<string, OpenUserRequest[]>, workerId: string): OpenUserRequest[] {
  return (ledger[workerId] ?? []).filter((entry) => entry.status === "open");
}

/** 清掉已結案項目、避免帳本無限成長；每個 worker 至少保留最近幾筆 resolved 供追溯。 */
export function pruneResolved(ledger: Record<string, OpenUserRequest[]>, keepResolved = 4): void {
  for (const [key, list] of Object.entries(ledger)) {
    const open = list.filter((entry) => entry.status === "open");
    // slice(-0) 會回整個陣列，keepResolved<=0 時要顯式回空。
    const allResolved = list.filter((entry) => entry.status === "resolved");
    const resolved = keepResolved > 0 ? allResolved.slice(-keepResolved) : [];
    const merged = [...open, ...resolved].sort((a, b) => a.at - b.at);
    if (merged.length) ledger[key] = merged;
    else delete ledger[key];
  }
}

/**
 * 教練 prompt 用的「優先承接」區塊。明令：這些是使用者未結案請求，優先於自己的階梯；
 * 唯有真正處理完才在決策 JSON 的 resolvedRequestIds 回報該 id。open 為空回空字串（不佔版面）。
 */
export function openRequestsCoachSection(open: OpenUserRequest[]): string {
  if (!open.length) return "";
  const lines = open.map((entry) => `- [${entry.id}] ${bounded(entry.text, 600)}`).join("\n");
  return `\n\nOPEN USER REQUESTS (from the real human owner, NOT the loop — these OVERRIDE your ladder):\n${lines}\n- These are un-actioned requests the owner made. PRIORITIZE continuing/completing them over any self-directed next step; a user request outranks "one rung higher" on your own thread.\n- Only when a request is GENUINELY addressed, list its id in "resolvedRequestIds". Never mark one resolved just because a turn ran — unfinished work stays open and carries to the next step.`;
}

/**
 * 換腦交接用的「原文照搬」區塊。借鑑影片：新腦第一眼就看到真人要的東西，逐字、不壓縮。
 */
export function openRequestsHandoffSection(open: OpenUserRequest[]): string {
  if (!open.length) return "";
  const lines = open.map((entry) => `- [${entry.id}] ${bounded(entry.text, OPEN_REQUEST_TEXT_MAX)}`).join("\n");
  return t(
    "\n\n未結案使用者請求（真人原文，逐字保留，不得壓縮或省略；接手後第一優先確認這些是否已處理）：\n{lines}",
    { lines },
  );
}

// ── 重啟持久化（比照 WorkerAutopilotRetroStore，key＝workerId）──────────────────
export class OpenUserRequestStore {
  private readonly file: string;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, "worker-open-requests.json");
  }

  load(): Record<string, OpenUserRequest[]> {
    try {
      return normalizeOpenRequests(JSON.parse(fs.readFileSync(this.file, "utf8")));
    } catch {
      return {}; // 檔案不存在或壞掉 → 當成沒有帳本
    }
  }

  save(ledger: Record<string, OpenUserRequest[]>): void {
    try {
      fs.writeFileSync(this.file, JSON.stringify(ledger, null, 2));
    } catch (error) {
      console.error("[open-requests] 無法保存未結案使用者請求帳本:", error);
    }
  }
}
