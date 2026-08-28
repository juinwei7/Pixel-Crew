/** 從回合錯誤訊息認出「撞到訂閱用量上限」並解析重置時刻。
 *  已知格式："You've hit your session limit · resets 2:50pm (Asia/Taipei)"、
 *  "...usage limit reached ... resets 3pm"。時間是使用者本地時區（與伺服器相同）。
 *  週上限那種帶日期的格式解析不了時間點會落在 24 小時內：提早開火只會再失敗一次，
 *  新的錯誤訊息會重新排程，屬有界的自我修正，不另外處理。 */
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
