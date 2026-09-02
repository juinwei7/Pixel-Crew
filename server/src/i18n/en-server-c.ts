/** server 端英文字典 C（其餘模組：runner/store/departments/工具類）。 */
export const enServerC: Record<string, string> = {
  // safeLocalPath.ts
  "目標路徑超出工作資料夾": "Target path is outside the workspace folder",
  "工作路徑不能包含符號連結": "Workspace path cannot contain a symbolic link",

  // attachmentRepository.ts
  "附件檔案遺失，已略過：{id} ({name})": "Attachment file missing, skipped: {id} ({name})",
  "無法保存附件索引": "Could not save the attachment index",

  // nativeCommands.ts
  "{name} 正在忙碌中": "{name} is currently busy",
  "無法重建工作階段": "Could not rebuild the session",

  // toolPolicy.ts
  "內建唯讀工具": "Built-in read-only tool",
  "MCP 工具標示為唯讀": "MCP tool marked as read-only",
  "MCP 工具未提供可信的唯讀標記": "MCP tool does not provide a trusted read-only marker",
  "工具可能修改本機或系統狀態": "Tool may modify local or system state",

  // providers/claudeAuthStatus.ts
  "找不到 Claude Code CLI": "Claude Code CLI not found",
  "無法確認 Claude 登入狀態": "Could not confirm Claude sign-in status",

  // providers/codexAuthStatus.ts
  "找不到 Codex CLI": "Codex CLI not found",

  // capabilities.ts
  "無法取得詳細資訊": "Could not retrieve details",

  // codexCapabilities.ts
  "讀取失敗": "Failed to read",
  "指令名稱不能空白": "Command name cannot be blank",
  "指令名稱只能用英數字、- 或 _，且需以字母開頭": "Command name can only use letters, digits, - or _, and must start with a letter",
  "這個指令已經存在": "This command already exists",

  // platform/commandLine.ts
  "MCP 指令的引號沒有成對": "MCP command has unmatched quotes",
  "MCP 指令不能是空白": "MCP command cannot be blank",

  // platform/paths.ts
  "請輸入本機絕對路徑": "Please enter a local absolute path",
  "目前 Windows 版本先支援本機磁碟；UNC 與 WSL 網路路徑尚未開放": "This Windows build only supports local disks for now; UNC and WSL network paths aren't supported yet",
  "工作位置不是資料夾": "The workspace location is not a folder",
  "找不到這個資料夾，請確認本機絕對路徑": "This folder could not be found, please confirm the local absolute path",

  // platform/processes.ts
  "Windows 指令參數包含不安全的換行字元": "Windows command argument contains an unsafe line-break character",
  "CLI {target} 超過 {maxBuffer} bytes": "CLI {target} exceeded {maxBuffer} bytes",

  // platform/directoryPicker.ts
  "選擇工作資料夾": "Select a workspace folder",
  "目前平台不支援原生資料夾選擇器": "The current platform does not support a native folder picker",

  // runnerShared.ts
  "無限制模式已開啟（不設限）": "Invincible mode is on (no restrictions)",
  "完全自動核准已開啟": "Full auto-approve is on",
  "安全自動核准已開啟": "Safe auto-approve is on",
  "完全自動核准已開啟，但此操作仍需確認（{detail}）": "Full auto-approve is on, but this action still needs confirmation ({detail})",
  "安全自動核准已開啟，但此操作仍需確認（{detail}）": "Safe auto-approve is on, but this action still needs confirmation ({detail})",
  "已中止": "Aborted",

  // claudeRunner.ts
  "使用者拒絕這項操作": "The user rejected this action",
  "唯讀查詢使用 {tool}": "Read-only query used {tool}",
  "唯讀查詢已拒絕 {tool}": "Read-only query rejected {tool}",
  "唯讀協作已拒絕 {tool}": "Read-only collaboration rejected {tool}",
  "唯讀 NPC 協作不允許需要額外權限的操作": "Read-only NPC collaboration doesn't allow actions that need extra permissions",
  "Claude 執行了這個指令": "Claude ran this command",
  "Claude 使用了 {tool}": "Claude used {tool}",
  "允許 Claude 執行這個指令？": "Allow Claude to run this command?",
  "允許 Claude 使用 {tool}？": "Allow Claude to use {tool}?",
  "Claude Code 需要額外權限；「本次皆允許」只套用目前工作階段的建議規則：{rules}": "Claude Code needs extra permission; \"Allow for this session\" only applies the suggested rules for the current session: {rules}",
  "Claude Code 需要額外權限才能繼續目前回合": "Claude Code needs extra permission to continue this turn",
  "Pixel Crew 工作階段已結束": "The Pixel Crew session has ended",

  // codexRunner.ts
  "已建立新的 Codex 對話；後續工作不會沿用先前上下文。": "A new Codex conversation has been created; subsequent work won't carry over the previous context.",
  "Codex 對話內容已壓縮。": "The Codex conversation has been compacted.",
  "已設定目標：{objective}": "Goal set: {objective}",
  "已清除目標。": "Goal cleared.",
  "目前沒有設定目標。": "No goal is currently set.",
  "目前目標：{objective}（狀態：{status}）": "Current goal: {objective} (status: {status})",
  "等待既有 Claude 工作階段回報訂閱用量": "Waiting for an existing Claude session to report subscription usage.",
  "計畫\n{text}": "Plan\n{text}",
  "唯讀模式已拒絕指令": "Read-only mode rejected the command",
  "唯讀模式已拒絕檔案變更": "Read-only mode rejected the file change",
  "唯讀模式已拒絕提高權限": "Read-only mode rejected the permission escalation",
  "唯讀查詢不允許需要額外權限的操作": "Read-only query doesn't allow actions that need extra permissions",
  "Codex 執行了這個指令": "Codex ran this command",
  "允許執行這個指令？": "Allow running this command?",
  "允許套用檔案變更？": "Allow applying this file change?",
  "允許提高工作權限？": "Allow elevating work permissions?",

  // dangerousCommand.ts
  "遞迴或強制刪除（rm -r / -f）": "Recursive or forced delete (rm -r / -f)",
  "刪除目標包含根目錄、家目錄、萬用字元或上層目錄": "Delete target includes the root directory, home directory, a wildcard, or a parent directory",
  "刪除目標是根目錄、家目錄或萬用字元": "Delete target is the root directory, home directory, or a wildcard",
  "使用 sudo 提升權限": "Uses sudo to escalate privileges",
  "格式化磁區（mkfs）": "Formats a disk partition (mkfs)",
  "直接讀寫裝置檔（dd ...=/dev/...）": "Directly reads/writes a device file (dd ...=/dev/...)",
  "直接寫入裝置檔": "Directly writes to a device file",
  "關機或重新啟動系統": "Shuts down or restarts the system",
  "遞迴開放所有權限（chmod -R 777）": "Recursively opens all permissions (chmod -R 777)",
  "下載並直接執行遠端指令": "Downloads and directly executes a remote command",
  "強制推送（git push --force）覆蓋遠端歷史": "Force push (git push --force) overwrites remote history",
  "硬重置（git reset --hard）可能捨棄未提交的變更": "Hard reset (git reset --hard) may discard uncommitted changes",
  "{tool} 可能修改本機或外部資料": "{tool} may modify local or external data",
  "無法辨識指令內容": "Could not recognize the command content",
  "串接中含寫入型重導向、替換語法或不在唯讀清單的片段": "The chained command contains a write-type redirect, substitution syntax, or a segment not on the read-only allowlist",
  "指令不在唯讀／驗證安全清單": "Command is not on the read-only/verified-safe allowlist",

  // messageImages.ts
  "圖片附件格式不正確": "Image attachment format is invalid",
  "每則訊息最多 {max} 張圖片": "Each message may include at most {max} images",
  "第 {n} 張圖片格式不正確": "Image #{n} has an invalid format",
  "只支援 PNG、JPEG 與 WebP 圖片": "Only PNG, JPEG, and WebP images are supported",
  "第 {n} 張圖片資料無效": "Image #{n} data is invalid",
  "每張圖片不可超過 {mib} MiB": "Each image cannot exceed {mib} MiB",
  "第 {n} 張圖片內容與格式不符": "Image #{n} content does not match its format",
  "圖片總大小不可超過 {mib} MiB": "Total image size cannot exceed {mib} MiB",

  // messageDocuments.ts
  "文件附件格式不正確": "Document attachment format is invalid",
  "每則訊息最多 {max} 份文件": "Each message may include at most {max} documents",
  "第 {n} 份文件格式不正確": "Document #{n} has an invalid format",
  "只支援 TXT、Markdown、CSV、JSON、HTML、XML、YAML、PDF 與 Office 文件": "Only TXT, Markdown, CSV, JSON, HTML, XML, YAML, PDF, and Office documents are supported",
  "第 {n} 份文件資料無效": "Document #{n} data is invalid",
  "每份文件不可超過 {mib} MiB": "Each document cannot exceed {mib} MiB",
  "第 {n} 份文件內容與格式不符": "Document #{n} content does not match its format",
  "文件總大小不可超過 {mib} MiB": "Total document size cannot exceed {mib} MiB",
  "Pixel Crew 已將使用者附加的文件暫存為以下唯讀檔案。請把它們視為本次訊息的附件，依使用者要求用讀檔工具檢視；不要修改或刪除附件：\n{list}": "Pixel Crew has staged the user's attached documents as the following read-only files. Treat them as attachments to this message and use a file-reading tool to view them as the user requests; do not modify or delete the attachments:\n{list}",

  // mcpLogin.ts
  "登入逾時（4 分鐘內未完成瀏覽器授權），已自動取消": "Login timed out (browser authorization wasn't completed within 4 minutes), automatically cancelled",
  "登入成功": "Login succeeded",
  "登入失敗（exit {code}）": "Login failed (exit {code})",
  "使用者取消登入": "User cancelled the login",

  // providerUsage.ts
  "本次時段": "This session",
  "本週": "This week",
  "{n} 分鐘": "{n} min",
  "{n} 小時": "{n} hr",
  "{n} 天": "{n} days",
  "短期": "Short-term",
  "長期": "Long-term",
  "Claude /usage 沒有回傳可辨識的用量區間": "Claude /usage did not return any recognizable usage windows",
  "Codex 用量查詢逾時": "Codex usage query timed out",
  "Codex 沒有回傳可用的 rate-limit 區間": "Codex did not return any usable rate-limit windows",
  "無法讀取工作能量": "Could not read work energy",

  // commandLibrary.ts
  "指令名稱只能使用英數、-、_、.，並可用 / 分類": "Command name may only use letters, digits, -, _, ., and can use / for categories",
  "指令路徑不合法": "Command path is invalid",
  "指令內容不能是空白": "Command content cannot be blank",
  "指令內容不能超過 200 KB": "Command content cannot exceed 200 KB",
  "/{name} 已經存在": "/{name} already exists",
  "指令儲存後無法讀取": "Could not read the command back after saving",

  // skillLibrary.ts
  "Skill 名稱只能使用小寫英數、-、_，最多 64 個字元": "Skill name may only use lowercase letters, digits, -, _, up to 64 characters",
  "Skill 路徑不合法": "Skill path is invalid",
  "Skill 內容不能是空白": "Skill content cannot be blank",
  "Skill 內容不能超過 300 KB": "Skill content cannot exceed 300 KB",
  "SKILL.md frontmatter 的 name 必須和資料夾名稱相同": "The name in SKILL.md frontmatter must match the folder name",
  "SKILL.md 必須提供 description": "SKILL.md must provide a description",
  "Skill {name} 已經存在": "Skill {name} already exists",
  "Skill 儲存後無法讀取": "Could not read the skill back after saving",

  // avatarStore.ts
  "只接受 PNG 或 GIF 角色圖片": "Only PNG or GIF character images are accepted",
  "角色動畫必須是有效的 GIF": "Character animation must be a valid GIF",
  "角色圖片資料無效或過大": "Character image data is invalid or too large",
  "角色圖片不是有效的 Base64": "Character image is not valid Base64",
  "GIF 尺寸最大為 {max} × {max} 像素": "GIF dimensions cannot exceed {max} × {max} pixels",
  "GIF 結尾包含多餘資料": "GIF trailer contains extra data",
  "GIF extension 不完整": "GIF extension block is incomplete",
  "GIF block 結構無效": "GIF block structure is invalid",
  "GIF frame 尺寸無效": "GIF frame dimensions are invalid",
  "GIF frame 資料不完整": "GIF frame data is incomplete",
  "GIF LZW 編碼無效": "GIF LZW encoding is invalid",
  "GIF 超過 {max} 個影格上限": "GIF exceeds the {max}-frame limit",
  "GIF 超過安全解碼像素預算，請縮短動畫或降低尺寸": "GIF exceeds the safe decode pixel budget, please shorten the animation or reduce its size",
  "GIF 沒有完整的圖片 frame": "GIF has no complete image frame",
  "GIF data sub-block 不完整": "GIF data sub-block is incomplete",
  "GIF data sub-block 缺少結尾": "GIF data sub-block is missing its terminator",
  "角色圖片必須是 PNG": "Character image must be a PNG",
  "PNG 標頭無效": "PNG header is invalid",
  "角色圖片必須正好是 {w} × {h} 像素": "Character image must be exactly {w} × {h} pixels",
  "角色 PNG 必須使用 8-bit RGB 或 RGBA 色彩": "Character PNG must use 8-bit RGB or RGBA color",
  "角色 PNG 必須使用標準非交錯格式": "Character PNG must use standard non-interlaced format",
  "PNG 區塊不完整": "PNG chunk is incomplete",
  "PNG 區塊無效": "PNG chunk is invalid",
  "PNG 校驗失敗": "PNG checksum failed",
  "PNG 首個區塊必須是 IHDR": "The first PNG chunk must be IHDR",
  "PNG 包含重複標頭": "PNG contains a duplicate header",
  "PNG 結尾無效": "PNG trailer is invalid",
  "PNG 缺少圖片資料": "PNG is missing image data",
  "PNG 圖片資料無法解壓縮": "PNG image data could not be decompressed",

  // backupImport.ts
  "備份檔案解壓後過大或包含過多項目": "The backup archive is too large when extracted or contains too many entries",
  "不允許的檔案類型：{path}": "Disallowed file type: {path}",
  "不安全的路徑：{path}": "Unsafe path: {path}",
  "備份檔案包含未知項目：{path}": "The backup archive contains an unknown entry: {path}",
  "不是有效的 Pixel Crew 備份檔案": "Not a valid Pixel Crew backup file",
  "備份檔案版本不受支援，請使用相容版本的 Pixel Crew 匯出": "This backup file's version is not supported, please use an export from a compatible Pixel Crew version",
  "備份檔案缺少資料庫": "The backup file is missing its database",
  "資料庫檔案格式無效": "The database file format is invalid",
  "資料庫完整性檢查失敗，此備份檔案可能已損毀": "Database integrity check failed, this backup file may be corrupted",
  "資料庫缺少必要的資料表": "The database is missing required tables",
  "已略過 {n} 個角色圖片（驗證失敗）": "Skipped {n} character image(s) (validation failed)",

  // providerInstaller.ts
  "正在執行官方安裝器": "Running the official installer",
  "安裝完成，正在檢查登入狀態": "Install complete, checking sign-in status",
  "安裝失敗": "Install failed",
  "官方安裝器執行失敗": "The official installer failed to run",
  "尚未開始": "Not started yet",

  // store.ts
  "伺服器重啟，交接已中止": "Server restarted, the handover was aborted",
  "伺服器重啟，NPC 協作已中止": "Server restarted, the NPC collaboration was aborted",
  "伺服器重啟，Department Mission 已中止": "Server restarted, the Department Mission was aborted",
  "從既有工作位置自動建立": "Auto-created from an existing workspace",
  "上次 LLM 交接未完成，已保留原本的工作階段": "The last LLM handover didn't finish, the original session was kept",
  "交接未完成": "Handover incomplete",

  // voice/voiceModel.ts, voiceTranscribe.ts, voiceEngineServer.ts, voiceRoutes.ts
  "模型下載連線失敗（HTTP {status}）": "Model download connection failed (HTTP {status})",
  "模型檔完整性驗證失敗，已刪除不完整檔案": "Model file integrity check failed; the incomplete file was deleted",
  "模型下載失敗": "Model download failed",
  "找不到本機語音轉寫引擎": "Local voice transcription engine not found",
  "此裝置不支援自動安裝語音轉寫引擎": "This device does not support automatic voice-engine installation",
  "語音轉寫引擎下載連線失敗（HTTP {status}）": "Voice transcription engine download failed (HTTP {status})",
  "語音轉寫引擎下載大小不符": "Voice transcription engine download size did not match",
  "語音轉寫引擎完整性驗證失敗，已刪除下載檔案": "Voice transcription engine integrity check failed; the download was deleted",
  "語音轉寫引擎解壓失敗": "Voice transcription engine extraction failed",
  "語音轉寫引擎檔案不完整": "Voice transcription engine files are incomplete",
  "語音轉寫引擎安裝失敗": "Voice transcription engine installation failed",
  "目前已有語音轉寫在處理中，請稍候": "A voice transcription is already in progress, please wait",
  "語音轉寫失敗（引擎回應 {status}）": "Voice transcription failed (engine responded {status})",
  "語音轉寫失敗": "Voice transcription failed",
  "語音轉寫引擎啟動失敗": "The voice transcription engine failed to start",
  "語音轉寫引擎啟動逾時": "The voice transcription engine timed out while starting",
  "語音模型尚未下載完成": "The voice model has not finished downloading",
  "錄音資料格式不正確": "The recording data is not in a valid format",
  "沒有偵測到語音，可重試": "No speech was detected, you can try again",
  "語音轉寫失敗，請重試": "Voice transcription failed, please try again",
};
