# 一鍵程式更新規格

> 狀態：實作中 v0.1
> 日期：2026-09-01
> 範圍：Windows x64 正式 ZIP 打包版

## 目標

當 GitHub 發布較新的正式 Pixel Crew Release 時，已安裝的 Windows x64 打包版可由介面的「下載並更新」完成下載、完整性驗證、程式替換與自動重新開啟。不要求使用者操作 Git、Node.js 或手動解壓。

## 非範圍

- 原始碼 clone 維持 `git pull` 與 `setup-windows.cmd`；不執行不透明的程式覆蓋。
- macOS 首版維持現有安裝腳本更新流程。
- 不在背景自動下載或自動替換；一定要由使用者按鈕確認。

## 流程與安全界線

```text
偵測 GitHub 最新正式版
  → 僅打包 Windows 顯示「下載並更新」
  → 若任一 NPC 忙碌，拒絕開始
  → 暫存下載 ZIP + SHA256SUMS.txt
  → SHA-256 比對成功才解壓
  → 驗證內含 Node、server、web、啟動器
  → 等舊 server 完整關閉
  → 舊程式目錄移至同層可復原備份
  → 暫存的新程式目錄移至原位置
  → 用原本的 VBS 背景啟動器重新開啟
```

- 僅接受 `juinwei7/Pixel-Crew` 的精確版本 ZIP，版本值必須為 `x.y.z`。
- ZIP 的 SHA-256 必須符合相同 Release 的 `SHA256SUMS.txt`；不符合時不解壓、不取代任何檔案。
- 使用者資料一律留在 `%LOCALAPPDATA%\Pixel Crew`，更新不讀寫工作 repository。
- 替換途中失敗時，若舊程式目錄已移走但新目錄尚未就位，立即搬回舊目錄。
- 下載、驗證或解壓失敗時，自動重新開啟原本的程式，並在 `%LOCALAPPDATA%\Pixel Crew\logs\self-update-error.log` 留下不含敏感資料的失敗原因。
- 更新 helper 必須先複製到 `%TEMP%` 執行，避免把正在執行的檔案鎖在待替換目錄。

## 驗收

- source clone 不會顯示一鍵更新按鈕，且 API 拒絕請求。
- 打包版可在閒置狀態更新並自動重新開啟。
- 任一 NPC 忙碌時 API 回覆明確錯誤，沒有下載或關閉 server。
- 竄改 ZIP 或 checksum manifest 時保留原安裝內容。
- 解壓後缺少必要程式檔時保留原安裝內容。
