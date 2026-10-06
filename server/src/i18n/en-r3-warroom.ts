/** 第三輪（R3）warroom 新增字串的英文翻譯。 */
export const enR3Warroom: Record<string, string> = {
  // 挑戰方立場說明
  "魔鬼代言人：專挑風險／成本／技術債／為何不該做，戳破過度樂觀；但最後的總體判斷要誠實，風險都可控就別為反對而反對。":
    "Devil's advocate: hunt for risks, costs, tech debt and reasons not to do it, and puncture over-optimism — but keep your overall call honest; if every risk is manageable, don't oppose just for the sake of it.",
  // 臨時席位不足
  "作戰室需要 {n} 個臨時席位，但辦公室目前已滿。請先移除幾位閒置的 NPC，或等其他作戰室散會後再開。":
    "The war room needs {n} temporary seats, but the office is full. Remove a few idle NPCs, or wait for another war room to wrap up, then try again.",
  // 議題背景
  "召集人": "Convener",
  "召集人：{host}{role}；專案：{project}": "Convener: {host}{role}; project: {project}",
  "（未命名）": "(unnamed)",
  "召集人最近的對話（節錄）：": "Convener's recent conversation (excerpt):",
  "使用者": "User",
  "\n\n【背景】\n{context}": "\n\n[Background]\n{context}",
  // 總體判斷信號與反駁輪
  "\n\n最後單獨一行標出你的真實底線（不是角色立場）：<position>GO</position>（該做／看好）、<position>HOLD</position>（有條件／再觀察）或 <position>NO</position>（不該做／看壞），三選一。就算你負責唱反調，只要你提的風險都有配套可解、你不會因此否決，就標 GO；真的認為不該做才標 NO。":
    "\n\nOn the last line, on its own, mark your honest bottom line (not your assigned stance): <position>GO</position> (do it / bullish), <position>HOLD</position> (conditional / wait and see) or <position>NO</position> (don't / bearish) — pick exactly one. Even if your job is to argue against it, mark GO when every risk you raised has a workable fix and you would not block it; mark NO only if you truly think it should not be done.",
  "\n對照你自己第 1 輪的主張：被說服而修正的點要明講，堅持的點補上更強的理由。最後一行同樣標出你現在的 <position>GO|HOLD|NO</position>。":
    "\nCompare against your own round-1 position: say plainly which points you revised because you were persuaded, and give stronger reasons for the ones you keep. End with your current <position>GO|HOLD|NO</position> on the last line as well.",
  // 主持裁決
  "{count} 方的表態（第 1 輪即判斷一致，已省略反駁輪）": "the positions of {count} participants (they agreed in round 1, so the rebuttal round was skipped)",
  "{count} 方的一輪表態": "a single round of positions from {count} participants",
  "{count} 方兩輪的辯論（立場＋反駁）": "a two-round debate between {count} participants (positions + rebuttals)",
  "你是圓桌主持人，握有最終裁決權。主題：{topic}{context}\n\n以下是{shape}：\n{debate}\n\n請務實整合；若各方一致，仍要點出挑戰方提過的主要風險，別讓共識變成盲點。完成後只輸出下列格式，不要加 Markdown code fence、不要在標籤外多寫字：\n<warroom_result>{\"verdict\":\"\",\"confidence\":\"high|medium|low\",\"consensus\":[\"\"],\"disputes\":[{\"point\":\"\",\"ruling\":\"\"}],\"rejected\":[{\"option\":\"\",\"reason\":\"\"}],\"flip_if\":[\"\"],\"actions\":[{\"priority\":\"P1|P2|P3|P4\",\"title\":\"\",\"how\":\"\"}],\"metrics\":[{\"label\":\"\",\"value\":\"\",\"note\":\"\"}],\"charts\":[{\"type\":\"line|bar|donut\",\"title\":\"\",\"labels\":[\"\"],\"values\":[0],\"unit\":\"\"}]}</warroom_result>\n其中 verdict＝一段話最終結論；confidence＝你對結論的信心（證據紮實＝high、推論合理但缺關鍵數據＝medium、多靠臆測或分歧未解＝low）；consensus＝共識清單；disputes＝分歧點與你的裁決；rejected＝被考慮過但否決的選項與原因（最多 4 個）；flip_if＝出現什麼證據或情況就該推翻這個結論（1–3 條，要具體可觀察）；actions＝可執行下一步（含優先級與具體做法／檔案）；metrics＝關鍵數字（3–8 個）：label 名稱、value 數值（含單位，例 \"44,933\" / \"+0.48%\"）、note 補充；charts＝圖表數據（最多 3 張）：辯論中有「數據序列」時輸出——走勢/時間序列用 line、類別對比用 bar、占比/配置用 donut；labels 與 values 一一對應（values 必須是純數字）、unit 是單位。只放辯論中真實出現且有依據的數據，嚴禁編造；沒有就留空陣列。":
    "You are the round-table moderator with final ruling authority. Topic: {topic}{context}\n\nBelow is {shape}:\n{debate}\n\nSynthesize pragmatically; if everyone agrees, still call out the main risks the challenger raised so consensus doesn't become a blind spot. When done, output only the format below — no Markdown code fence, no extra text outside the tags:\n<warroom_result>{\"verdict\":\"\",\"confidence\":\"high|medium|low\",\"consensus\":[\"\"],\"disputes\":[{\"point\":\"\",\"ruling\":\"\"}],\"rejected\":[{\"option\":\"\",\"reason\":\"\"}],\"flip_if\":[\"\"],\"actions\":[{\"priority\":\"P1|P2|P3|P4\",\"title\":\"\",\"how\":\"\"}],\"metrics\":[{\"label\":\"\",\"value\":\"\",\"note\":\"\"}],\"charts\":[{\"type\":\"line|bar|donut\",\"title\":\"\",\"labels\":[\"\"],\"values\":[0],\"unit\":\"\"}]}</warroom_result>\nWhere verdict = a final conclusion in prose; confidence = how confident you are in it (solid evidence = high, reasonable inference but missing key data = medium, mostly speculation or unresolved disagreement = low); consensus = list of agreed points; disputes = points of disagreement and your ruling; rejected = options that were considered but rejected, with the reason (up to 4); flip_if = what evidence or situation should overturn this conclusion (1–3 items, concrete and observable); actions = actionable next steps (with priority and concrete approach/files); metrics = key numbers (3–8): label name, value (with unit, e.g. \"44,933\" / \"+0.48%\"), note for extra context; charts = chart data (up to 3): output when the debate contains a \"data series\" — use line for trends/time series, bar for category comparisons, donut for shares/allocation; labels and values must correspond one-to-one (values must be plain numbers), unit is the unit label. Only include data that genuinely appeared in the debate with evidence — never fabricate; leave an empty array when there's none.",
  // 信心與報告
  "高": "High",
  "中": "Medium",
  "低": "Low",
  "**信心程度**：{level}\n\n": "**Confidence**: {level}\n\n",
  "（第 1 輪即判斷一致，已省略反駁輪）\n\n": "(Everyone agreed in round 1, so the rebuttal round was skipped.)\n\n",
  "## 什麼會推翻這個結論\n{items}\n\n": "## What would overturn this conclusion\n{items}\n\n",
  "## 被否決的選項\n{items}\n\n": "## Rejected options\n{items}\n\n",
  "裁決信心：{level}（證據不足，動工前請先跟使用者確認方向）\n\n": "Verdict confidence: {level} (evidence is thin — confirm the direction with the user before starting work)\n\n",
  "裁決信心：{level}\n\n": "Verdict confidence: {level}\n\n",
};
