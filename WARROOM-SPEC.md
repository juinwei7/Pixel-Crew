# 「作戰室（War Room）」功能設計交接文件

> 這份是給「一個乾淨、context 很輕的新 NPC / 新對話」照著實作用的。目的是把設計從一個已經很肥、
> 每輪都在燒 token 的對話裡搬出來，讓實作在便宜的 context 下進行。**先讀完再動手。**

## 0. 使用者的真正意圖（最重要，別誤解）
- 「省代幣」的真意＝**別在還沒拿到答案前，這時段的額度就被燒光、卡著空等重置**。不是「花最少」，而是「**在額度內把答案交到手，跑得完、不被突襲**」。
- 使用者要的圓桌是**真・多方向討論 + 真・分工並行**：一個協調者丟問題、拆工，多個 agent **同時**各司其職（一個寫碼、一個想新方向、一個執行驗證），不是「單一機器人找答案」。
- 對照：目前已上線的「🗣️圓桌」是**刻意的廉價替身**（單一 NPC 扮多角色、一次性、省 token），日常快問用。**作戰室不取代它，兩個並存、使用者按需選。**

## 0.5 設計定調（來自兩支參考影片，務必照這個方向）
使用者看了兩支影片，作戰室要照這兩支的結論合起來做：

**A) 架構 = 「lead + peers」（來自 @hackproduct「ONE CLAUDE — 3 ways to scale」的 pattern 02「AGENT TEAM」）**
- 一個 **LEAD（老闆＝主持 NPC，走便宜模型）** 在上，底下 SHARED TASKS 分給數個 **peer**（例如 FRONTEND / BACKEND / TESTS，對應「寫碼 / 想新方向 / 執行驗證」）。
- peer 特性：**SHARED TASKS · DIRECT MSGS · OWN CONTEXT**（共享任務、可互傳、各有自己的 context）。
- 這正是 Pixel Crew 既有的 department + mission（`boss_worker_id` = lead）——**重用它**，不要重寫。

**B) 省 token 的關鍵 = 「精選 context」而非「寫短」（來自「寫短一點為什麼沒用」教學）**
- 每個 peer 的 OWN CONTEXT **只餵三種東西**：①剛下的規則 ②這一步要改的檔案 ③現在要用的工具。
- **明確丟掉**：繞遠路的討論過程、上一個任務的檔案、已經修好的報錯。
- 換句話說「封頂」不只是限制輪數/agent 數，更是**限制每個 peer 拿到的 context 內容**——給它「這一步的那一小片」，不要倒整段歷史。這是讓 pattern 02（每 peer OWN CONTEXT＝本來很貴）變可負擔的核心手法。

> 一句話：**老闆帶 peers（強）＋每個 peer 只拿精選 context（省）＋臨時建/用完刪（不累積）＋封頂保底（跑得完）。**

## 1. 核心設計原則：封頂 + 保底 + 預估
- **封頂**：每次作戰室跑，硬上限——最多 2–3 個 specialist agent、單輪（不無限來回辯論）、有 token/時間上限。
- **保底**：無論如何協調者**一定先產出「目前為止的結論」**再結束；撞到上限就把手上收集到的東西強制綜合交出——**絕不允許「燒完卻兩手空空」**。
- **預估 + 預算旋鈕**：開跑前顯示預估花費，使用者可設「這次最多花多少」；跑的時候有即時用量。讓使用者「看得到、控得住」，不被突襲。
- **ephemeral**：specialist 用「臨時 worker / fresh session」跑，**用完即刪**，不累積到任何持久 NPC 的對話史（累積＝之後每輪重讀變貴，正是要避免的病）。

## 2. 架構（重用，不要重寫）
Pixel Crew **已經有**多智能體編排的骨架，別從零造：
- `server/src/department.ts` / `departmentPlan.ts` / `departmentThread.ts` / `mission.ts`：部門派工 / mission（協調者→多 NPC）。
- `server/src/collaboration.ts`：1-對-1 唯讀 consult/review（結構化結果解析 `parseCollaborationResult` 可參考，作戰室的結果解析照它的模式做）。
- `server/src/claudeRunner.ts`：`setModel()` → CLI `--model`，**per-worker 可設模型**（協調者用便宜模型 Haiku、寫碼 specialist 用強模型）。
- fresh session 機制：`freshSession.ts`、`/api/workers/:id/model/fresh`、`/api/workers/:id/provider/fresh`。

**作戰室 = 在 department/mission 引擎外面包一個更好用的入口**：
「丟一句問題 → 協調者(便宜模型)拆 2–3 個角色 → 並行開臨時 specialist → 各自做 → 協調者綜合成結論 → 臨時 specialist 刪除」。

### 實作前必先確認（reuse vs rebuild 的關鍵）
1. department 引擎能不能**真並行**跑多個 worker？（看 departmentThread 怎麼派）
2. 能不能**建了就刪**（ephemeral worker 的 create→用→delete 生命週期）？若不行，退而用「專用作戰室 NPC + 每次 fresh session」。
3. 現成有沒有 token/時間上限與 timeout 機制可掛？沒有就要自己補「封頂+強制綜合」。
> 建議用**子代理並行**去讀這三塊、回報結論，再決定包裝重用還是另寫輕量編排器。別在主對話裡整包讀（會把 context 撐爆）。

## 3. 前端入口（與現有圓桌並存）
- 現有廉價圓桌：`web/src/roundtablePrompt.ts` + `App.tsx` 的 `roundtableMode` 開關（🗣️圓桌鈕）+ `GameCanvas` 的「🗣️圓桌討論中…」氣泡 + 圓桌自動降 Haiku（`roundtableOriginalModel` ref + 還原 effect）。**保留。**
- 新增「🏛️作戰室」入口：獨立按鈕/對話框，收問題 + 顯示預估 + 預算旋鈕 → 呼叫後端作戰室 API → 顯示「各 specialist 進度 + 最終綜合結論」的結果卡。
- 視覺（可選、擺最後）：觸發時相關臨時 NPC 上桌圍圈、跑完散開（純 pixi，零 token）。

## 4. 已完成、已上線的東西（別重做）
本批已 build 並套到部署目錄的 `web\dist`（前端 only，backend 沒動）：
- 🗣️圓桌功能（單一 NPC 模擬 + 自動降 Haiku 跑完還原）
- 修：輸入框 ↑/↓ 不再吃字；快速雙 Enter 不再砍任務
- 效能：App 的 workerList / collaborations / missions / departments 已 `useMemo`，GameCanvas 不再每 render 重算 pixi
- 美化：輸入列按鈕過場/hover/focus 環
- 一鍵切換腳本：`Downloads\Pixel-Crew-main\套用更新到wei.cmd`（被 SmartScreen 擋過；也可手動只複製 web/dist）

## 4.5 ⭐ 臨時 NPC「自己新增→用完刪除」機制（已實測驗證，直接照抄）
使用者最想要的：圓桌/作戰室**不要**跑在持久 NPC 上污染它的對話史，而是**程式自動開一個臨時 NPC → 跑 → 用完刪掉**。以下 API 已於 8787 實測通過（建 id 5bbd85b0…、刪除確認、數量正確回復）：

- **建立**：`POST /api/workers`，body `{ provider:"claude", workspacePath:"<存在的絕對路徑>", name:"圓桌", model:"haiku" }`，回傳 `workerSummary`（含 `id`）。前端用 `createWorker(name, provider, workspacePath)`（`useWorkers.ts:413`，回 `{id}` 或 `{error}`）。
- **送訊息**：`POST /api/workers/:id/message` body `{message}`（非同步；答案經 WebSocket `turn_end` 回來）。前端用 `send(id, {text, images, documents})`。
- **刪除**：`DELETE /api/workers/:id`。前端 `handleRemoveWorker(id)`（`App.tsx:481`，注意它可能有確認流程；純程式刪用 `useWorkers` 的 remove 或直接 `apiRequest` DELETE）。
- **接答案（唯一難點）**：答案在 `workers[id].turns` 最後一則的 `resultText`（`types.ts:99`）。務必**在刪除前先把 `resultText` 抓出來**顯示到結果卡/母 NPC 的 log，否則一刪就沒了。可重用既有的「圓桌 NPC 忙過又閒置」偵測（`App.tsx` 的 `roundtableSeenBusy` 機制）當作「turn 完成」的訊號，完成時抓 resultText → 顯示 → 刪除臨時 worker。
- **注意**：中文路徑（如 `d:\米線`）用 curl 會編碼壞掉；程式內用前端函式或 PowerShell `ConvertTo-Json` 就正常。`MAX_WORKERS` 有上限，臨時 worker 一定要確保刪掉（try/finally），否則撞上限建不出來。

### 建議實作流程（前端 only、免重啟 backend）
1. 圓桌送出 → `createWorker("圓桌", provider, workspace)` 拿 id（失敗就 fallback 跑在當前 NPC）。
2. `send(id, roundtablePrompt(text))`；用忙→閒偵測等 `turn_end`。
3. 抓 `workers[id].turns` 末筆 `resultText` → 顯示。
4. `try/finally` 確保最後 `removeWorker(id)`（就算中途錯也要刪，別留殭屍）。
5. 全程加封頂/timeout：等太久就刪掉臨時 worker 並回報，不無限等。

## 4.6 ⭐⭐ 視覺：會議室圍桌（使用者最想要的畫面，必做）
使用者的核心願景不只是功能，而是**畫面感**：開圓桌後，畫面上要有「**一群 NPC 圍在一張大桌子前開會**」的樣子，像真的會議室/作戰室。這是必做、不是 nice-to-have。
- 在 pixi 場景（`web/src/game/scene.ts` + `furniture.ts` + `personalDesks.ts`）加一張**大會議桌 furniture**（作戰室專用），圓桌進行時把參與的臨時 peer NPC **移動到桌邊圍坐/站**（用既有的 `station:"meeting"` 概念，subagents 已用過類似位置），lead 在主位。
- 討論中每個 peer 頭上冒對話泡（沿用現有 speech bubble），完成打勾；Lead 綜合時聚焦到 lead。
- 結論出來、grace period 後 peers 起身離開並被刪除（散會動畫）。
- 觸發點可用 `worker_created` / `worker_removed` broadcast + 一個「這批屬於某圓桌」的標記來驅動聚集/散開。
- 重點：**先有「圍桌」的靜態位置感，再談走動動畫**；靜態圍坐就已達成使用者要的「會議室」感。

## 5. 小 UX 待修（順手）
- 圓桌模式開著時，打 `/xxx` 斜線指令會被包成討論文字、不執行。應讓 `/` 開頭的輸入**繞過圓桌包裝**，直接當指令送。

## 6. 驗證方式
- `cd web && npm run build`（tsc + vite）要過；`npm test`（tsx --test）要全綠（目前 187/187）。
- server：`cd server && npx tsc -p tsconfig.json`；`npm test`（注意 `authDebug.test.ts` 有個**跨平台既有 fail**，與本功能無關）。
- 部署：只改前端就 build 後把 `web/dist` 複製到 `Desktop\wei\web\dist`、重整頁面；有改到 server 才需重啟 8787（會短暫斷 NPC）。
