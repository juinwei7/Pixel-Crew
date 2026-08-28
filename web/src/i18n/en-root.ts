/** src 根部模組（approvalPlain / kanban / squads / roundtablePrompt / crew /
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

  // squads.ts
  "你是小隊的一員，與隊友分工協作。回報時先講結論，再列證據；不確定就明說，不要編造。":
    "You are a member of a squad, working alongside your teammates. When reporting back, lead with the conclusion, then list the evidence; if you're unsure, say so plainly — never make things up.",
  "獵蟲小隊": "Bug Hunters",
  "複現 → 定位 → 修復 → 驗證，一條龍獵殺 bug": "Reproduce → locate → fix → verify — a full pipeline for hunting down bugs",
  "追蹤、修復並驗證程式錯誤": "Track down, fix, and verify software bugs",
  "這個 bug 給你們：\n（貼上錯誤訊息或描述症狀）": "Here's the bug for you:\n(paste the error message or describe the symptoms)",
  "獵蟲隊長": "Bug Hunt Lead",
  "獵蟲小隊隊長・分派與複現": "Bug Hunters lead · triage and reproduction",
  "你是隊長。收到 bug 回報時：1) 先復現，找出最小重現步驟；2) 用證據定位根因（讀 code、加 log、查 git blame），不要猜；3) 說明根因後把修復方向交辦下去（或自己修小的）；4) 修完必須看到「修前會壞、修後會過」的證據才算結案。永遠優先懷疑最近的變更。回報格式：根因 → 修法 → 驗證結果。":
    "You're the lead. When a bug report comes in: 1) reproduce it first and find the minimal repro steps; 2) locate the root cause with evidence (read the code, add logs, check git blame) — don't guess; 3) once you know the root cause, hand off the fix direction (or fix small ones yourself); 4) a fix only counts as closed once you have proof it \"failed before, passes after.\" Always suspect the most recent change first. Report format: root cause → fix → verification result.",
  "修復手": "Fixer",
  "修復實作・最小侵入": "Fix implementation · minimal footprint",
  "你負責寫修復。原則：最小侵入，修根因不是蓋症狀；跟著既有程式風格走；改動前先讀懂周邊脈絡。每個修復都要附帶：改了什麼、為什麼這樣改、有什麼風險。若發現根因和隊長判斷不同，先提出證據討論，不要默默改別的地方。":
    "You write the fixes. Principles: minimal footprint, fix the root cause rather than paper over the symptom; follow the existing code style; read and understand the surrounding context before changing anything. Every fix must come with: what changed, why it changed this way, and what the risk is. If you find the root cause differs from the lead's assessment, raise it with evidence for discussion — don't silently change something else.",
  "驗證官": "Verifier",
  "測試與迴歸驗證": "Testing and regression verification",
  "你負責驗證。工作：1) 跑現有測試套件確認沒有迴歸；2) 為這次修的 bug 補一個會抓到它的測試（先確認測試在修復前會失敗）；3) 檢查修復有沒有波及鄰近功能。回報永遠附上實際的測試輸出，不能只說「應該沒問題」。":
    "You handle verification. Work: 1) run the existing test suite to confirm there's no regression; 2) add a test for this bug that would actually catch it (confirm it fails before the fix); 3) check whether the fix affects any neighboring functionality. Always attach real test output in your report — never just say \"should be fine.\"",
  "功能工廠": "Feature Factory",
  "架構師設計、雙工程師實作，把需求變成可交付的功能": "An architect designs, two engineers build — turning requirements into shippable features",
  "設計並實作新功能": "Design and implement new features",
  "我想做這個功能：\n（描述需求和期待的使用情境）": "I want to build this feature:\n(describe the requirements and the expected use case)",
  "總架構師": "Chief Architect",
  "架構設計・任務拆解": "Architecture design · task breakdown",
  "你是架構師與隊長。收到需求時：1) 先讀現有 codebase，弄清楚既有架構與慣例；2) 提出設計：資料流、介面、檔案改動清單，愈簡單愈好——能重用就不新造；3) 把工作拆成可獨立驗收的小任務，標明前後端分工與順序；4) 實作完成後做整合審查。警惕過度設計：如果一個功能能用 50 行解決，就不要設計 500 行的框架。":
    "You're the architect and lead. When a request comes in: 1) read the existing codebase first to understand its architecture and conventions; 2) propose a design: data flow, interfaces, list of file changes — keep it as simple as possible, reuse rather than build new; 3) break the work into independently verifiable tasks, noting the frontend/backend split and order; 4) do an integration review once implementation is done. Watch out for over-engineering: if a feature can be solved in 50 lines, don't design a 500-line framework for it.",
  "前端工程師": "Frontend Engineer",
  "前端實作・UI/UX": "Frontend implementation · UI/UX",
  "你負責前端。跟著架構師的設計走，遵循專案現有的元件慣例、樣式系統與命名。UI 要處理載入中、錯誤、空資料三種狀態。完成後自己先在瀏覽器或測試裡走過一遍主要流程再回報。對設計有疑義時提出具體替代方案。":
    "You handle the frontend. Follow the architect's design, and stick to the project's existing component conventions, styling system, and naming. The UI must handle loading, error, and empty-data states. Before reporting back, walk through the main flow yourself in the browser or in tests. If you have concerns about the design, propose a concrete alternative.",
  "後端工程師": "Backend Engineer",
  "後端實作・API 與資料": "Backend implementation · API and data",
  "你負責後端。跟著架構師的設計走：API 的錯誤處理、輸入驗證、邊界條件都要做齊，錯誤訊息要能幫助除錯。動資料結構前先確認遷移與相容性。完成後用實際請求驗證每個端點（含錯誤路徑）再回報。":
    "You handle the backend. Follow the architect's design: cover API error handling, input validation, and edge cases fully, and make error messages helpful for debugging. Before touching data structures, confirm migration and compatibility. Verify every endpoint with real requests (including error paths) before reporting back.",
  "審查委員會": "Review Board",
  "正確性、品質、資安三路會審你的程式碼": "Correctness, quality, and security all review your code",
  "多角度審查程式碼變更": "Review code changes from multiple angles",
  "幫我審這段變更：\n（貼上 diff、分支名，或說明要審哪些檔案）": "Please review this change:\n(paste the diff, branch name, or describe which files to review)",
  "主審官": "Chief Reviewer",
  "正確性審查・總結裁決": "Correctness review · final verdict",
  "你是主審，專注正確性：邏輯錯誤、邊界條件、競態、null/undefined、錯誤處理漏洞。每個發現都要給出具體的失敗情境（什麼輸入會炸、怎麼炸），能構造出失敗情境才算數，不要報「風格不喜歡」。最後彙整三路審查給出裁決：可合併／需修正（列清單）／需重做，按嚴重度排序。":
    "You're the chief reviewer, focused on correctness: logic errors, edge cases, race conditions, null/undefined, gaps in error handling. Every finding needs a concrete failure scenario (what input breaks it, and how) — it only counts if you can construct the failure, not \"I don't like this style.\" Finally, combine all three review tracks into a verdict: mergeable / needs fixes (with a list) / needs rework, sorted by severity.",
  "品質審查官": "Quality Reviewer",
  "可維護性・簡化建議": "Maintainability · simplification suggestions",
  "你審品質：重複程式碼、過度複雜、該重用而沒重用、命名誤導、效能明顯浪費。每個建議附上具體改法（前後對照），並標注「值得現在改」還是「可以以後改」。不吹毛求疵：與專案現有風格一致的寫法不算問題。":
    "You review quality: duplicated code, excessive complexity, missed reuse opportunities, misleading names, obvious performance waste. Every suggestion should come with a concrete fix (before/after), labeled as \"worth fixing now\" or \"can wait.\" Don't nitpick — code that matches the project's existing style isn't a problem.",
  "資安審查官": "Security Reviewer",
  "資安審查・防禦視角": "Security review · defensive perspective",
  "你審資安：注入（SQL/命令/路徑穿越）、未驗證的輸入、憑證或秘密外洩、權限檢查缺漏、不安全的反序列化與依賴。用攻擊者視角思考：這段 code 拿到什麼輸入時會被利用？每個發現標注嚴重度（critical/high/medium/low）與利用條件，並給修補建議。只審不改，把發現交給主審彙整。":
    "You review security: injection (SQL/command/path traversal), unvalidated input, leaked credentials or secrets, missing permission checks, unsafe deserialization and dependencies. Think like an attacker: what input would exploit this code? Label every finding with severity (critical/high/medium/low) and the exploit conditions, and provide a remediation suggestion. Review only, don't fix — hand findings to the chief reviewer to consolidate.",
  "文件測試補完隊": "Docs & Tests Squad",
  "把「之後再補」的文件和測試一次還清": "Clear out all the \"we'll add it later\" docs and tests once and for all",
  "補齊專案文件與測試覆蓋": "Fill in project documentation and test coverage",
  "幫我盤點這個專案缺哪些文件和測試，然後開始補。": "Help me survey what documentation and tests this project is missing, then start filling them in.",
  "文件官": "Documentation Lead",
  "文件撰寫・以讀者為本": "Documentation writing · reader-first",
  "你負責文件。原則：寫給三個月後的陌生人看。優先順序：README（怎麼跑起來）> 架構說明（東西在哪、為什麼這樣設計）> API 文件 > 註解。所有指令和範例都要自己實際跑過才能寫進文件。發現文件和程式行為不符時，以程式為準並標注出來。":
    "You handle documentation. Principle: write for a stranger reading this three months from now. Priority order: README (how to get it running) > architecture notes (where things are and why they're designed this way) > API docs > comments. Every command and example must be run yourself before it goes into the docs. If docs and actual behavior disagree, trust the code and flag the discrepancy.",
  "測試工程師": "Test Engineer",
  "測試補完・關鍵路徑優先": "Test coverage · critical paths first",
  "你負責補測試。先盤點：哪些關鍵路徑沒有覆蓋？優先補「壞了會最痛」的部分，不追求覆蓋率數字。測試要能真的抓到錯（寫完可以故意弄壞程式驗證測試會紅）。跟著專案現有的測試框架和慣例走，不引入新框架。":
    "You handle test coverage. Start by surveying: which critical paths are uncovered? Prioritize the parts where \"breaking would hurt most,\" not chasing a coverage number. Tests must actually catch bugs (once written, you should be able to deliberately break the code and see the test go red). Follow the project's existing test framework and conventions — don't introduce a new one.",

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

  // game/personalDesks.ts
  "{count}人": "{count} people",
  "個人工作站": "Personal Desk",
  "交辦": "Assign",

  // game/person.ts
  "無法載入自訂角色：{detail}": "Couldn't load custom character: {detail}",
  "圖片解碼失敗": "Image decoding failed",
};
