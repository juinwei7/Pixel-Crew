import { randomUUID } from "node:crypto";

// 「兩段式確認」共用的暫存 token 倉：prepare 端點 issue() 發 token，commit 端點
// take()（取出即作廢）或 peek()+discard()（先查驗、成功才作廢——departments 用，
// 讓使用者在名單變動等 409 後還能拿同一顆 token 重試）。
// 每次 issue 都先掃掉過期項，Map 不會無限長大。
export class PreparedTokenStore<T> {
  private readonly entries = new Map<string, { value: T; expiresAt: number }>();

  constructor(private readonly ttlMs: number) {}

  issue(value: T): string {
    const now = Date.now();
    for (const [token, entry] of this.entries) {
      if (entry.expiresAt < now) this.entries.delete(token);
    }
    const token = randomUUID();
    this.entries.set(token, { value, expiresAt: now + this.ttlMs });
    return token;
  }

  take(token: string): T | null {
    const entry = this.entries.get(token);
    this.entries.delete(token);
    return entry && entry.expiresAt >= Date.now() ? entry.value : null;
  }

  peek(token: string): T | null {
    const entry = this.entries.get(token);
    if (!entry) return null;
    if (entry.expiresAt < Date.now()) {
      this.entries.delete(token);
      return null;
    }
    return entry.value;
  }

  discard(token: string): void {
    this.entries.delete(token);
  }
}
