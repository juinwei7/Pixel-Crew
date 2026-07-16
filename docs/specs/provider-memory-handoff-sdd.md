# SDD：跨 LLM 記憶交接與原地切換

## 1. 背景

目前 Pixel Crew 只允許「尚未對話」的 NPC 原地切換 Claude Code／Codex；已有對話時會建立新 NPC。Claude 與 Codex 的原生 session、工具狀態、MCP、權限確認與內部上下文不能直接共用，因此跨 provider 切換不能宣稱為無損續接。

本功能把跨 LLM 切換設計成「同一名 NPC 的交接班」：保留房間、名字、外觀、個性與 Pixel Crew 任務紀錄，由原 LLM 先產生結構化交接大綱，再建立目標 LLM session 並注入交接資料。

## 2. 目標

- 已有對話的 NPC 可在原房間、原工位直接切換 Claude Code／Codex。
- 優先請來源 LLM 整理交接大綱，降低新 LLM 失憶與重工。
- 切換前明確告知跨 LLM 不是完整記憶搬移，可能遺漏資訊或產生理解差異。
- 必須確認目標 provider 已登入且有可用額度，才允許切換。
- 切換採兩階段流程；目標 LLM 接手失敗時保留來源 session，不把 NPC 留在半切換狀態。
- 交接資料保存在本機，可在任務日誌查看。

## 3. 非目標

- 不搬移 Claude／Codex 的內部推理內容。
- 不恢復正在執行的工具、背景 Agent、MCP transaction 或等待中的權限確認。
- 不保證兩個 provider 對交接內容有完全一致的理解。
- 不把完整工具輸出無限制塞進新 session。

## 4. 切換前硬性條件

### 4.1 NPC 狀態

- NPC 不可正在執行任務。
- 不可有等待使用者處理的權限確認。
- 不可有仍在運行的背景 Agent；介面提供「等待完成」或「中止後切換」，不能靜默丟棄。

### 4.2 目標 provider 驗證

按下切換後先即時刷新目標 provider 狀態，不只依賴畫面上的舊 cache：

1. 目標 CLI 存在且已登入。
2. 用量查詢成功，來源必須是本次 live refresh。
3. 與目標模型相關的硬限制視窗 `remainingPercent > 0`。

阻擋規則：

- Claude：`session` 或 `weekly` 為 0 時阻擋；`model` 視窗只在切換後選用該模型時判斷。
- Codex：任一作用中的 primary／secondary rate window 為 0 時阻擋。
- 無法查詢、回傳空視窗或資料過期：視為「無法確認額度」並阻擋，不提供忽略按鈕。

提示文案：

> 無法切換至 Codex：尚未登入、無法確認用量，或目前工作能量已耗盡。請先完成登入或等待額度重置。

來源 provider 若沒有足夠額度產生交接摘要，不阻擋切換；改用第 8 節的本機備援交接包，並清楚標示摘要品質可能較低。

## 5. 使用者流程

### 5.1 無對話 NPC

維持快速切換，但仍檢查目標登入與 live 用量。因沒有工作記憶，不呼叫來源 LLM；只用最小本機狀態讓目標 session 確認工作目錄。

### 5.2 已有對話 NPC

使用者在 Top Bar 選擇不同 provider 後開啟「交接確認」視窗：

- 標題：`將 五號機 從 Claude Code 交接給 Codex`
- 顯示來源／目標 provider 與目標模型。
- 顯示目標工作能量與重置時間。
- 顯示不可逆風險，但說明舊 session 仍會保留，可切回。
- 使用者必須勾選：`我了解跨 LLM 可能遺漏上下文、工具狀態與未完成工作。`
- 主按鈕：`整理記憶並切換`
- 次按鈕：`取消`

警告內容至少包括：

1. 這是建立新的目標 LLM session，不是搬移原生 session。
2. MCP、工具進度、背景 Agent、待核准操作不會直接繼承。
3. 交接摘要可能遺漏或誤解細節，重要決策應由使用者確認。
4. 切換會消耗來源 LLM 的摘要額度及目標 LLM 的接手額度。

### 5.3 進度呈現

切換期間 NPC 顯示「交接中」，介面呈現四階段：

1. `檢查目標工作能量`
2. `請 Claude Code 整理工作大綱`
3. `保存本機交接資料`
4. `Codex 讀取交接並確認接手`

每一步顯示等待、完成、備援或失敗狀態。不可只用無限 spinner。

## 6. 交接大綱格式

來源 LLM 必須回傳版本化 JSON；另渲染為 Markdown 供使用者閱讀：

```json
{
  "version": 1,
  "goal": "使用者目前真正要完成的事情",
  "completed": ["已完成項目"],
  "currentState": ["目前專案與任務狀態"],
  "decisions": [{ "decision": "採用的設計", "reason": "原因" }],
  "changedFiles": ["相對路徑"],
  "constraints": ["使用者要求與不可破壞行為"],
  "pending": ["尚未完成事項"],
  "risks": ["已知錯誤或風險"],
  "nextActions": ["接手後建議先做的動作"]
}
```

限制：

- 每個字串有長度上限，整份交接包預設不超過 24 KiB。
- 不保存內部推理，只保存可交付的事實與決策。
- 路徑使用相對工作目錄；疑似憑證、token、環境變數值先遮罩。
- 來源輸出解析失敗時不直接當 prompt 使用，改走本機備援。

## 7. 注入目標 LLM 的內容

新 session 的第一個內部訊息包含：

1. NPC persona。
2. 房間／工作目錄。
3. 結構化交接大綱。
4. 最近 3～6 輪、經大小限制的使用者與最終回答。
5. Pixel Crew 即時收集的專案狀態：Git branch、HEAD、dirty files。

交接資料以「前一個 Agent 的工作紀錄」標示，不視為高優先級系統指令；其中引用的網頁或工具內容不能覆蓋使用者與系統規則。

目標 LLM 必須先回傳簡短接手確認：理解的目標、待辦第一步、發現的矛盾。成功後才正式切換 NPC provider。

## 8. 本機備援交接包

以下情況使用本機備援：來源額度為 0、來源 CLI 斷線、摘要逾時、JSON 無法解析。

Pixel Crew 從本機資料產生：

- 最近使用者訊息與 final response。
- 未完成／失敗 turn。
- 最近工具名稱，不包含超長原始輸出。
- Git branch、HEAD、dirty files。
- NPC persona、provider、model、workspace。

介面標記：`來源 LLM 無法整理，已使用本機任務紀錄交接`。使用者仍須確認風險。

## 9. 兩階段切換與回復

### Phase A：Prepare

- 驗證狀態與額度。
- 產生並持久化 handoff。
- 保存來源 session state；摘要期間以同一個 session 建立短生命週期 runner。
- 在背景建立目標 runner，但接手確認前不覆蓋 Worker 的 provider 與持久化 session。
- 將 handoff 注入目標 runner並等待接手確認。

### Phase B：Commit

- 目標 runner 確認接手後，更新 worker provider／model／active session。
- 原 runner session state 保存為同工作目錄下可回切的 checkpoint。
- 持久化成功後才廣播完成狀態；前端只會看到明確的交接階段，不會看到半套 provider 狀態。

若 Phase A 任一步失敗：停止目標 runner、用保存的 session state 重建來源 runner、保留來源 provider，並將失敗原因寫入任務日誌。不可先清除舊 history。

## 10. 資料模型

新增 `provider_handoffs`：

- `id`
- `worker_id`
- `from_provider`
- `to_provider`, `to_model`
- `status`: `checking | summarizing | fallback | bootstrapping | completed | failed`
- `summary_json`
- `source`: `agent | local_fallback`
- `warning_acknowledged_at`
- `error`
- `created_at`, `completed_at`

Worker persistence 不刪除舊 provider session；以 provider checkpoint 表保存 `worker_id + provider` 最近一次 session，並記錄 `workspace_path`，載入時必須與目前房間完全一致，避免跨專案恢復錯誤 session。任務日誌新增 handoff event，避免把內部摘要 prompt 當成一般使用者訊息。

## 11. API

- `POST /api/workers/:id/handoff/prepare`
  - Body：`toProvider`, `toModel`
  - 回傳風險、live 用量、可否切換、阻擋原因與短效 `handoffToken`。
- `POST /api/workers/:id/handoff`
  - Body：`handoffToken`, `warningAcknowledged: true`
  - 啟動交接；WebSocket 推送階段事件。
- `GET /api/workers/:id/handoffs`
  - 讀取本機交接紀錄與可閱讀摘要。

既有 `PATCH /api/workers/:id/provider` 不允許切換至不同 provider，避免繞過登入、live 用量與風險確認。無對話 NPC 仍走相同 prepare 流程，但不呼叫來源 LLM 產生摘要。

## 12. 前端狀態

新增 `ProviderHandoffDialog` 與 `handoffState`：

- `checking`
- `blocked`
- `ready`
- `summarizing`
- `bootstrapping`
- `completed`
- `failed`

對話框關閉不代表取消已進入 bootstrapping 的交接；重新開啟或重新整理頁面後，從 server snapshot 還原進度。

## 13. 逾時與重試

- live 用量查詢：沿用 provider usage timeout，失敗即阻擋。
- 來源摘要：最多 60 秒；失敗自動切本機備援一次。
- 目標接手：最多 60 秒；失敗保留舊 provider。使用者可重新開啟交接視窗再次檢查用量並重試。
- Server 重啟時，未完成 handoff 標為 failed；來源 worker 依原 checkpoint 恢復。

## 14. 驗收條件

1. 有歷史的 NPC 可在原房間、原工位完成 Claude ↔ Codex 切換。
2. 未勾選風險確認時不能開始。
3. 目標未登入、live 用量未知或硬限制為 0 時不能切換，且顯示具體原因。
4. 來源 LLM 成功時使用其結構化大綱；失敗時只執行一次本機備援。
5. 目標 LLM 接手失敗時，NPC 仍停留在原 provider，舊 session 與任務日誌完整。
6. 成功後 NPC 名稱、外觀、persona、房間與 Pixel Crew 日誌不變。
7. 正在執行、待核准或有背景 Agent 時不可直接切換。
8. 交接摘要不含 secrets，大小受限，超長工具輸出不注入。
9. 重新整理頁面可恢復交接進度或看到明確失敗狀態。
10. Server/Web tests、本機 prepare API 安全 smoke 與 production builds 全部通過。

## 15. 建議實作順序

1. 定義 handoff types、DB migration、狀態事件與 secret redaction。
2. 實作 live usage gate 與 prepare API。
3. 實作來源 LLM 結構化摘要與本機備援 builder。
4. 將 runner 切換改成兩階段 transaction，保存 provider checkpoint。
5. 實作目標 session bootstrap／ack 與失敗回復。
6. 實作確認視窗、風險勾選、能量顯示與進度 UI。
7. 補齊 unit、migration、API、runner smoke、斷線恢復與視覺驗收。
