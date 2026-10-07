// 作戰室席位排隊（純邏輯，不碰 worker／HTTP，方便單元測試）。
// 臨時席位不夠開一整場（成員＋主持）時，請求改排進 FIFO 佇列，等席位釋出再由外層依序開場。
// 規則：
// - 排隊中的請求不佔席位：席位只在「真正開場」那一刻由外層同步建立 worker／預留主持席。
// - 嚴格 FIFO：隊首坐不下就整條等，後面需求較小的也不插隊（避免大場永遠餓死）；
//   佇列非空時新請求一律排到隊尾，就算當下席位夠也一樣。
// - 所需席位超過理論上限（扣掉常駐 NPC 後最多能有的臨時席）→ 永遠等不到，直接拒絕、不排隊；
//   排隊期間常駐 NPC 變多導致變成不可能的，輪到它時也會被剔除。
// - 佇列有上限（預設 3 場）與最長等待時間（預設 30 分鐘），超過就拒絕／剔除。
// 佇列只存在記憶體：server 重啟後排隊全部失效，前端查詢時會拿到「找不到」並請使用者重開。

export const WARROOM_QUEUE_MAX = 3;
export const WARROOM_QUEUE_MAX_WAIT_MS = 30 * 60_000;

export type WarroomAdmission =
  | { kind: "start" }
  | { kind: "queue"; ahead: number }
  | { kind: "full" }
  | { kind: "impossible" };

export interface QueuedWarroom<T> {
  id: string;
  seats: number;
  enqueuedAt: number;
  payload: T;
}

export type WarroomDropReason = "expired" | "impossible";

export interface WarroomQueueStep<T> {
  start: QueuedWarroom<T> | null;
  dropped: Array<{ item: QueuedWarroom<T>; reason: WarroomDropReason }>;
}

export class WarroomQueue<T> {
  private items: QueuedWarroom<T>[] = [];

  constructor(
    readonly maxQueued = WARROOM_QUEUE_MAX,
    readonly maxWaitMs = WARROOM_QUEUE_MAX_WAIT_MS,
  ) {}

  get size(): number {
    return this.items.length;
  }

  // 新請求要不要開場／排隊／拒絕。seatsLeft＝此刻可用臨時席；maxSeats＝理論上最多可能有的臨時席。
  admit(seats: number, seatsLeft: number, maxSeats: number): WarroomAdmission {
    if (seats > maxSeats) return { kind: "impossible" };
    if (this.items.length === 0 && seats <= seatsLeft) return { kind: "start" };
    if (this.items.length >= this.maxQueued) return { kind: "full" };
    return { kind: "queue", ahead: this.items.length };
  }

  // 排到隊尾，回傳前面還有幾場。呼叫前應先 admit() 確認是 queue。
  enqueue(id: string, seats: number, payload: T, now: number): number {
    const ahead = this.items.length;
    this.items.push({ id, seats, enqueuedAt: now, payload });
    return ahead;
  }

  // 排隊中取消；已開場或不存在回 null。
  cancel(id: string): QueuedWarroom<T> | null {
    const index = this.items.findIndex((item) => item.id === id);
    if (index < 0) return null;
    const [removed] = this.items.splice(index, 1);
    return removed;
  }

  // 前面還有幾場；不在佇列裡回 null。
  ahead(id: string): number | null {
    const index = this.items.findIndex((item) => item.id === id);
    return index < 0 ? null : index;
  }

  // 一次只決定一場：先剔除逾時與不可能的，再看隊首坐不坐得下。外層開完一場後
  // 拿「最新的」剩餘席位再呼叫一次，直到 start 為 null——這樣席位數永遠以實際狀態為準。
  next(seatsLeft: number, maxSeats: number, now: number): WarroomQueueStep<T> {
    const dropped: WarroomQueueStep<T>["dropped"] = [];
    this.items = this.items.filter((item) => {
      if (now - item.enqueuedAt > this.maxWaitMs) {
        dropped.push({ item, reason: "expired" });
        return false;
      }
      return true;
    });
    while (this.items.length > 0 && this.items[0].seats > maxSeats) {
      dropped.push({ item: this.items.shift()!, reason: "impossible" });
    }
    const head = this.items[0];
    if (!head || head.seats > seatsLeft) return { start: null, dropped };
    this.items.shift();
    return { start: head, dropped };
  }
}
