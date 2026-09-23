# Pixel Crew 2.5.0 + 新功能分支（feat/advisor-and-schedule）

這是你 2.5.0 的原始碼樹，加上這批新功能／修正（分支 `feat/advisor-and-schedule`）。

## 這批改了什麼（9 個 commit）
- **專家顧問**：BOSS 桌丟一個粗略念頭 → 顧問列出你想不到的方向 → 挑一個直接交辦。
- **執行中燈號**：頂欄全域「N 在跑」。
- **排程每 N 分鐘重複**：營運面板排程新增重複模式。
- **跨裝置排隊佇列**：排隊改存 server → 切走的 NPC 自己會跑、手機/電腦同步。
- **部門日誌空白修正**：不同大小寫工作區的部門任務日誌不再空白。
- **migration 修正**：排程欄位改成新的 v8 migration（不然既有使用者更新後會開機崩）。

## 一鍵啟動測試版（安全，不碰你正在跑的 app）
雙擊 **`啟動測試版.cmd`** → 開瀏覽器到 **http://127.0.0.1:8799**
- 用 port 8799、資料是 `%LOCALAPPDATA%\Pixel Crew\_test-instance`（你資料的副本），跟正式版（8787）完全隔離。
- dist 沒建好會自動先 build。

## 自己 build / 測試
```powershell
cd server ; npx tsc -p tsconfig.json ; npx tsx --test test/**/*.test.ts
cd ..\web ; npx tsc -b ; npm test ; npx vite build
```

## 要正式上線（讓你真正的 app 吃到）
檔案級硬塞安裝目錄沒用（會被自動更新蓋回）。正解走發版：
1. `git checkout main && git merge feat/advisor-and-schedule`
2. 發一個 **v2.5.1** release（附打包產物，跟 2.5.0 同樣流程 `scripts/windows/package-app.mjs`）
3. app 會自動更新吃到。

⚠️ 發版前務必用「**已經 migrate 過的舊 DB**」開機測一次（就是這次抓到 migration bug 的方法），別只用空 DB 測。
