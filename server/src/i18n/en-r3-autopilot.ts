/** 第三輪（R3）autopilot 新增字串的英文翻譯。 */
export const enR3Autopilot: Record<string, string> = {
  "✅ 自動循環已達步數上限，自動停止；收尾報告在上一則回覆。要繼續就再打開開關。":
    "✅ Autopilot reached its step limit and stopped; the wrap-up report is in the previous reply. Turn the switch back on to continue.",
  "完成標準：{doneWhen}": "Done when: {doneWhen}",
  "（回覆結尾請用一句話對照這條完成標準，說明達成與否）": "(End your reply with one sentence stating whether this criterion was met.)",
  "上一步達標": "Previous step met its criterion",
  "上一步部分達標": "Previous step partly met its criterion",
  "上一步未達標": "Previous step missed its criterion",
  "這步：{reason}": "This step: {reason}",
  "自動循環已完成目標：{reason}。": "Autopilot reached the goal: {reason}.",
  "可選的下一步：{next}（要做就直接下指示或重開開關）": "Optional next step: {next} (give an instruction or switch autopilot back on to pursue it)",
  "🅿️ 自動循環卡住而停：{reason}。給個方向或選一個選項，就能換路接著做。": "🅿️ Autopilot stopped because it is stuck: {reason}. Give a direction or pick an option and it can take another route.",
  "卡點：{blocker}": "Blocker: {blocker}",
  "🅿️ 自動循環停下來等你拍板：{reason}。回覆選項或直接下指示即可接續。": "🅿️ Autopilot paused for your decision: {reason}. Reply with an option or give an instruction to continue.",
};
