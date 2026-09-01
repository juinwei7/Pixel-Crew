# Domain 模組化 SDD

## 原則

`server/src/index.ts` 仍負責程序組裝、全域 worker 編排與路由註冊；可獨立測試的 domain transport／service 逐步移出。每次只移一個可驗證邊界，禁止為縮短檔案做破壞性大搬家。

## 首個切面：Backup transport 與還原交易

`backupTransport.ts` 負責備份匯出：checkpoint 後的固定結構 tar、可選 AES-GCM 包裝、response headers、串流錯誤與 staging 清理。`backupImportTransport.ts` 負責上傳、解密與隔離驗證。`backupRestoreCommit.ts` 負責已驗證備份的提交交易：建立 pre-restore snapshot、換入、失敗 rollback、結果 marker 與 response 完成後的退出排程。

index 只保留程序層依賴的注入：maintenance mode、全域 worker／WebSocket 終止、store flush／checkpoint／close、pending-import token，以及最終 process exit；資料搬移與失敗處理不再散落於路由內。

## 第二個切面：Operational settings

`operationalSettingsRoutes.ts` 集中註冊 app settings 與 local diagnostics routes。它自行管理輸入白名單、診斷事件類型與診斷匯出；index 僅注入 `AppSettingsStore`、`LocalStore`、日期格式與 server 語言切換。這個邊界刻意不帶 worker 編排，避免把任何長任務狀態移入低耦合的產品設定模組。

## 第三個切面：Workspace workflow library

`workflowLibraryRoutes.ts` 管理 `.claude/commands` 與 `.agents/skills` 的讀、寫、刪 API，並在變更後通知相應 provider 的 idle worker 與 workflow watcher。index 只提供受控 workspace 正規化、worker refresh 與 watcher scan；檔案驗證與 API 錯誤邊界保留在這個 domain route 模組。

## 第四個切面：Reporting

`reportingRoutes.ts` 管理成本列表與一日回放的唯讀 API，直接重用 `dayReport.ts` 的純彙整函式。index 只注入目前 worker 的識別、顯示名稱與每日預算，因此路由模組不能操控 worker 或改寫任務狀態。

## 第五個切面：Schedule settings

`scheduleRoutes.ts` 擁有排程設定的 CRUD、時間格式驗證與 worker 存在性檢查。到點執行、provider readiness、審批安全策略及 WebSocket 狀態通知仍保留在 index 的程序迴圈，以明確區分設定資料與執行編排。

## 第六個切面：Named accounts

`accountRoutes.ts` 管理具名 provider 帳號的建立、刪除、驗證刷新與 OAuth/API-key 啟動。OAuth tracker、auth registry、worker warmup 與 WebSocket 通知透過 callback 注入；預設帳號與 worker session 重新綁定仍暫留 index，避免混淆不同生命週期。

## 第七個切面：Approval bridge

`approvalRoutes.ts` 集中驗證 worker、Mission 與 Claude approval bridge 的決策輸入與 HTTP 錯誤語意。index 只提供 runner 尋找及實際 `resolveApproval`／bridge response；每個決策仍限制於 `allow_once`、`allow_session`、`deny`。

## 前端核心檔案

`web/src/index.css` 現在是固定順序的五個樣式模組入口：scene/shell、avatar、workflow management、app shell/focus、composer/operations。原 selector 與 cascade 順序不變；CSS 結構測試會遞迴讀取入口 imports，防止未來分檔後失去版面 invariant 覆蓋。

`WarroomVerdictBody.tsx` 擁有 War Room 的圖表與裁決內容，供即時結果與歷史結果共用；`App.tsx` 保留資料取得、狀態與組裝，不再混入圖表渲染細節。

## 本輪完成定義

1. 主入口將可獨立驗證的 Backup、帳號、設定/診斷、workflow library、reporting、schedule、approval 等 domain 路由與服務移出。
2. 高耦合的 worker、Mission、Boss 編排仍由 index 作為 composition root；這是刻意的 ownership 邊界，不以單次大搬家改寫。
3. 前端核心 CSS 與可重用 War Room 呈現已分檔，且 build、全部測試、bundle budget 與 diff 檢查通過。

帳號、worker、Mission/Boss 的其他 route 可繼續逐片搬移，屬未來演進而非本輪完成的阻擋條件。
