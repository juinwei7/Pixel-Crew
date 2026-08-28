/** 從回合錯誤訊息認出「撞到訂閱用量上限」並解析重置時刻。
 *  已知格式："You've hit your session limit · resets 2:50pm (Asia/Taipei)"、
 *  "...usage limit reached ... resets 3pm"。時間是使用者本地時區（與伺服器相同）。
 *  週上限那種帶日期的格式解析不了時間點會落在 24 小時內：提早開火只會再失敗一次，
 *  新的錯誤訊息會重新排程，屬有界的自我修正，不另外處理。 */
/** 撞上限期間被吞的聊天指示：去重累積，最多 10 則、每則截 600 字。
 *  前端佇列在 worker 一閒下來就會把排隊訊息全數送出；上限未重置時每一則
 *  都會立刻以失敗回合收場，靠這份清單在重置後把原文重新交付。 */
export function accumulateSwallowedText(list: string[], text: string): string[] {
  const trimmed = text.trim().slice(0, 600);
  if (!trimmed || list.includes(trimmed)) return list;
  return [...list, trimmed].slice(-10);
}

export function parseLimitReset(message: string, now: Date): Date | null {
  if (!/\b(?:session|usage|weekly)\s+limit\b|\blimit reached\b|hit your [^\n]*limit/i.test(message)) return null;
  const match = /resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i.exec(message);
  if (!match) return null;
  let hour = Number(match[1]) % 12;
  if (match[3].toLowerCase() === "pm") hour += 12;
  const minute = match[2] ? Number(match[2]) : 0;
  const at = new Date(now);
  at.setHours(hour, minute, 0, 0);
  if (at.getTime() <= now.getTime()) at.setDate(at.getDate() + 1);
  return at;
}
