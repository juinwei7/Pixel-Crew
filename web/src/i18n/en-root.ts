/** src 根部模組（approvalPlain / kanban / roundtablePrompt / crew /
 *  composerFiles / commandInteraction / workerState / workflowDocument）與
 *  game/*、avatar/* 的英文字典（key = 中文原文）。 */
export const enRoot: Record<string, string> = {
  // approvalPlain.ts
  "讀取一個檔案的內容": "Read the contents of a file",
  "列出符合條件的檔案": "List files matching a pattern",
  "在專案裡搜尋文字": "Search text within the project",
  "上網搜尋資料": "Search the web",
  "抓取一個網頁的內容": "Fetch the contents of a web page",
  "修改一個檔案": "Modify a file",
  "新建或覆寫一個檔案": "Create or overwrite a file",
  "編輯一個筆記本檔案": "Edit a notebook file",
  "派出一個子代理去做事": "Dispatch a subagent to do work",
  "終止一個背景指令": "Terminate a background command",
  "在終端機執行一條指令": "Run a command in the terminal",
  "高風險：{reason}": "High risk: {reason}",
  "不在安全白名單內，可能改動檔案或系統狀態，請看一下指令內容": "Not on the safe allowlist — it may change files or system state, please review the command",
  "改動檔案內容": "Change file contents",
  "會改寫這個檔案（改壞了可從版本控制或備份救回）": "This will overwrite the file (if it goes wrong you can recover it from version control or a backup)",
  "要求額外的工作權限": "Request additional working permissions",
  "核准後這個回合能做的事會變多，範圍見上方說明": "Approving this expands what can be done this turn — see the scope above",
  "唯讀操作，不會改動任何東西": "Read-only operation, nothing will be changed",
  "會用它自己的權限繼續動作，內容見技術細節": "It will continue acting with its own permissions — see the technical details",
  "使用外部服務「{server}」的工具：{label}": "Use a tool from the external service \"{server}\": {label}",
  "外部工具，實際行為由該服務決定；不確定就先拒絕": "External tool — its actual behavior is decided by that service; when unsure, deny it",
  "使用工具 {name}": "Use tool {name}",
  "非唯讀工具，可能改動狀態": "Not a read-only tool, it may change state",

  // kanban.ts
  "📥 待辦": "📥 To Do",
  "🏃 進行中": "🏃 In Progress",
  "⚠️ 需要處理": "⚠️ Needs Attention",
  "✅ 已完成": "✅ Done",
  "計畫等你核准": "Plan awaiting your approval",
  "審查沒有結論，等你決定": "Review was inconclusive, awaiting your decision",
  "修正次數用完，等你指示": "Out of correction attempts, awaiting your instructions",
  "步驟失敗，等你指示": "Step failed, awaiting your instructions",
  "成員不在了，等你調度": "Member is no longer available, awaiting your reassignment",
  "（已離職）": "(no longer here)",
  "等你處理": "Awaiting your attention",
  "老闆（你）": "Boss (you)",
  "AI 正在拆解任務…": "AI is breaking down the task…",
  "AI 有問題想先問你": "AI has a question for you first",

  // roundtablePrompt.ts
  "你正在 Pixel Crew 主持一場「圓桌討論」。使用者要的是討論後的「結果」，不是過程，也不是要你去派工。":
    "You're hosting a \"roundtable discussion\" in Pixel Crew. The user wants the discussion's \"result,\" not the process, and isn't asking you to dispatch work.",
  "重要限制（為了省時省 token）：這是一次性的內部模擬討論。不要呼叫任何工具、不要讀寫檔案、不要動 Git 或設定，":
    "Important constraint (to save time and tokens): this is a one-shot internal simulated discussion. Don't call any tools, don't read or write files, don't touch Git or settings, ",
  "就用你的知識在腦中扮演多個角色辯論一輪，然後直接在這一則回覆內產出結論。":
    "just use your own knowledge to play out a round of debate among several roles in your head, then produce the conclusion directly in this one reply.",
  "討論主題：{topic}": "Discussion topic: {topic}",
  "請自己依主題挑 2–4 個最相關的角色上桌（例如工程、QA、產品、設計、營運等），讓他們各自給出簡短意見與理由，":
    "Pick 2–4 of the most relevant roles for the table yourself based on the topic (e.g. engineering, QA, product, design, operations), and have each give a brief opinion with reasoning, ",
  "觀點該衝突就衝突；最後你以主持人身分整合出一個明確、可執行的結論。使用者最在意「結論」，所以要具體、能直接照做，不要打太極。":
    "let viewpoints clash where they should; then, as moderator, synthesize a clear, actionable conclusion. The user cares most about the \"conclusion,\" so be concrete and directly actionable — don't hedge.",
  "請完全照以下 Markdown 結構回覆，精簡為主：": "Reply exactly following this Markdown structure, keeping it concise:",
  "圓桌意見": "Roundtable Opinions",
  "角色（立場）": "Role (stance)",
  "意見與理由": "Opinion and reasoning",
  "（列 2–4 個角色）": "(list 2–4 roles)",
  "結論": "Conclusion",
  "一段話講清楚最後怎麼做。": "One paragraph making clear what to do.",
  "分歧 / 風險": "Disagreements / Risks",
  "有就列；沒有就寫「無」": "List them if any; write \"None\" if not",
  "下一步": "Next Steps",
  "具體行動": "Concrete action",

  // crew.ts
  "等待核准": "Awaiting approval",
  "執行中": "Running",
  "需注意": "Needs attention",
  "待命": "Standby",

  // composerFiles.ts
  "每則訊息最多 {max} 張圖片": "Up to {max} images per message",
  "每則訊息最多 {max} 份文件": "Up to {max} documents per message",
  "只支援 PNG、JPEG 與 WebP 圖片": "Only PNG, JPEG, and WebP images are supported",
  "每張圖片不可超過 5 MiB": "Each image can't exceed 5 MiB",
  "圖片總大小不可超過 10 MiB": "Total image size can't exceed 10 MiB",
  "只支援文字、Markdown、CSV、JSON、HTML、XML、YAML、PDF 與 Office 文件": "Only text, Markdown, CSV, JSON, HTML, XML, YAML, PDF, and Office documents are supported",
  "每份文件不可超過 10 MiB": "Each document can't exceed 10 MiB",
  "文件總大小不可超過 20 MiB": "Total document size can't exceed 20 MiB",

  // commandInteraction.ts
  "Claude 指令": "Claude commands",
  "Codex 原生指令": "Codex native command",

  // workerState.ts
  "工具 {name}": "Tool {name}",
  "權限遭拒": "Permission denied",
  "未獲授權": "Not authorized",
  "權限問題：{detail}": "Permission issue: {detail}",
  "Agent 回合失敗，但 CLI 沒有提供詳細原因；請重試或查看啟動 Pixel Crew 的終端輸出。":
    "The agent turn failed, but the CLI didn't provide a detailed reason; please retry or check the terminal output where Pixel Crew was started.",
  "子代理": "Subagent",
  "協助處理任務": "Helping with the task",
  "使用 {tool}…": "Using {tool}…",
  "等待核准…": "Awaiting approval…",
  "已拒絕操作": "Operation denied",
  "繼續執行…": "Continuing…",

  // workflowDocument.ts
  "Frontmatter 必須是 YAML object": "Frontmatter must be a YAML object",

  // avatar/normalizeAvatar.ts
  "瀏覽器無法建立圖片畫布": "Browser couldn't create an image canvas",

  // game/avatarPresets.ts
  "經典隊員": "Classic Crew",
  "原始制服 · 隨隊員配色": "Original uniform · matches member color",
  "霓虹工程師": "Neon Engineer",
  "深藍髮 · 青藍制服": "Dark blue hair · cyan uniform",
  "訊號分析師": "Signal Analyst",
  "銀灰髮 · 紫羅蘭制服": "Silver-gray hair · violet uniform",
  "火花設計師": "Spark Designer",
  "暖棕髮 · 桃紅制服": "Warm brown hair · pink uniform",
  "夜班維運": "Night Shift Ops",
  "黑藍髮 · 金橘制服": "Black-blue hair · amber uniform",

  // game/furniture.ts
  "任務板": "Task Board",
  "讀檔案": "Read Files",
  "寫程式": "Write Code",
  "上網查": "Web Search",
  "終端機": "Terminal",
  "驗證": "Verify",
  "其他工具": "Other Tools",
  "作戰室": "War Room",

  // stationTheme.ts（工作小窗／焦點大螢幕／3D 頭頂小窗共用主題表）
  "編輯器": "Editor",
  "瀏覽器": "Browser",
  "知識庫": "Docs",
  "看板": "Board",
  "白板": "Whiteboard",
  "正在執行指令": "Running commands",
  "正在寫程式": "Writing code",
  "正在上網查資料": "Browsing the web",
  "正在查閱文件": "Reading docs",
  "正在驗證測試": "Verifying tests",
  "正在更新看板": "Updating the board",
  "正在開會討論": "In a meeting",

  // game/personalDesks.ts
  "{count}人": "{count} people",
  "個人工作站": "Personal Desk",
  "交辦": "Assign",

  // game/person.ts
  "無法載入自訂角色：{detail}": "Couldn't load custom character: {detail}",
  "圖片解碼失敗": "Image decoding failed",
};
