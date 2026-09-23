# 三項新功能：實作指南（基底 v2.5.0）

給你自己加進 repo 用。三項功能、14 個檔、+493/−24 行。全部在 `Desktop\AI\Pixel-Crew-2.5.0` 的分支 `feat/advisor-and-schedule`（commit `e76a491`），已驗證：server tsc 零錯＋29 測、web tsc 零錯＋373 測、build 成功。

## 最快的套用法
```bash
# 在你自己的 2.5.0 repo 根目錄
git apply --check ADD_FEATURES.patch   # 先試套，無輸出＝可套
git apply ADD_FEATURES.patch           # 正式套
```
若某檔因你本地有改而衝突，就照下面「逐檔說明」手動加那一段。

---

## 功能 1：專家顧問（Expert Advisor）
**概念**：BOSS 交辦之前的前段。你丟一個粗略念頭 → 一個扮演資深顧問的決策模型，回幾個「你可能沒想到」的專業方向（每個附 insight／approach／considerations／可直接執行的 objective），或在太模糊時回一個聚焦提問。挑一個方向 → 預填進 BOSS 交辦框 → 既有的拆解→執行→報告那條龍照常接手。**不新建執行引擎，純接在 Boss Task 前面。**

**檔案**
- `server/src/expertAdvisor.ts`（新檔，純函式）：
  - `expertAdvisorPrompt({idea, workspacePath, maxProposals})` 組 prompt（marked block `<expert_advisor>`）。
  - `parseAdvisorResult()` / `explainAdvisorFailure()` 容錯解析＋失敗原因（給 repair 重試）。仿 `bossTask.ts` 的 determinism split。
  - 型別 `AdvisorProposal` / `AdvisorResult`。
- `server/test/expertAdvisor.test.ts`（新檔）：11 測釘死解析／缺 insight/objective 一律擋／超量擋／重複 id 擋等。
- `server/src/index.ts`：
  - import 三個函式。
  - 新增路由 `POST /api/advisor/propose`：讀 idea → `resolveDecisionRuntime()` 取 provider/model（沿用 Boss Task 那套）→ `runDetachedTurn(..., {kind:"no_tools"})` 跑一次 → 解析失敗補一次 repair → 回 `{result}`。
- `web/src/types.ts`：加 `AdvisorProposal` / `AdvisorResult`。
- `web/src/components/BossTaskDesk.tsx`：新任務視圖加「顧問」面板（輸入念頭→呼叫端點→列方向卡片→點卡片用 `localStorage` 預填草稿並重開 composer，跟 `starterTasks` 同機制）。
- `web/src/styles/composer-and-operations.css`：`.boss-task-desk__advisor*` 樣式。
- `web/src/i18n/en-modals-a.ts`：對應英文字串。

**串接關鍵**：挑方向後把 `proposal.objective` 塞進 `localStorage["pixel-crew:task-composer:boss:<ws>:new"]` 再 `setNewTask(true)`，交辦框就帶著那段目標，使用者按「交辦」即進 `onCreate`（既有 createBossTask）。

---

## 功能 2：執行中燈號（Running-count light）
**概念**：頂欄一顆全域燈，不分工作區顯示「現在幾個 NPC 在跑」。資料用既有的 `worker_status` WebSocket 廣播，零 server 改動。

**檔案**
- `web/src/App.tsx`：`const runningCount = useMemo(() => workerList.filter(w => w?.busy).length, [workerList])`；傳 `runningCount={runningCount}` 給 `<TopBar>`。
- `web/src/components/TopBar.tsx`：Props 加 `runningCount: number`；在 BOSS 按鈕後渲染 `.top-bar__running`（>0 顯示「N 在跑」綠點脈動、=0 暗掉顯示「待命」）。
- `web/src/styles/app-shell-and-focus.css`：`.top-bar__running*` 樣式＋`@keyframes runningPulse`。
- `web/src/i18n/en-app.ts`：「在跑」「目前有 {count} 位…」等英文。

---

## 功能 3：排程「每 N 分鐘重複」
**概念**：把排程從只有「每日 HH:MM 一次」加上「每 N 分鐘重複」。復用既有的 server 端 30 秒觸發迴圈與無人看管安全閘（⚡無限制模式照樣跳過）。

**檔案**
- `server/src/storeMigrations.ts`：`completeHistoricalStoreSchema` 尾端加兩欄
  `addColumnIfMissing(db, "schedules", "interval_minutes INTEGER")` 和 `"last_run_at TEXT"`。**相容舊資料：interval 為 null＝維持每日模式。**
- `server/src/store.ts`：`listSchedules` 多回 `intervalMinutes`/`lastRunAt`；`addSchedule` 多收 `intervalMinutes`；`updateSchedule` 可改 interval；`markScheduleRun(id, day, at?)` 同時寫 `last_run_at`。
- `server/src/scheduleRoutes.ts`：加 `normalizeInterval()`（夾在 5..10080 分）；POST/PATCH 接 `intervalMinutes`。
- `server/src/index.ts`：30 秒觸發迴圈改判斷——`recurring` 時用 `last_run_at + interval*60000` 判到點，否則走原本每日邏輯；訊息標籤 `scheduleLabel`（「每 N 分鐘」或「每日 HH:MM」）。
- `web/src/components/OpsModal.tsx`：新增模式下拉（每日／每隔一段時間）＋間隔輸入；清單顯示間隔。

---

## 驗證
```bash
# server
cd server && npx tsc -p tsconfig.json && npx tsx --test test/expertAdvisor.test.ts
# web
cd web && npx tsc -b && npm test && npx vite build
```

## 兩個踩過的坑（你會遇到）
1. **UI 一律禁 emoji**：`web/test/noEmojiIcons.test.ts` 會掃全 src，任何 `.ts/.tsx` 出現 emoji 就 fail（只有 `Icon.tsx` 例外）。所以顧問面板原本的 💡 我拿掉了；你加東西也別放 emoji，要圖示走 `<Icon name="…" />`。
2. **i18n key = 中文原文**：新字串若沒在 `en-*.ts` 補英文，切英文時會 fallback 顯示中文（不會壞，但不完整）。已補齊。

## 發版才會「留得住」
app 會從 GitHub releases 自動更新，所以**改安裝目錄的 dist 沒用**（會被自動更新蓋回）。要生效：merge → 發 release（附打包產物）→ app 自動更新。
