# 像素／專業模式規格

> 狀態：實作中 v1
> 日期：2026-09-02
> 範圍：Pixel Crew 前端工作介面

## 1. 目標

Pixel Crew 只保留兩種清楚、互補的工作方式：

- **像素模式**：預設入口。使用者在像素辦公室中選取 NPC、下達任務、快速掌握團隊狀態。
- **專業模式**：全螢幕工作台。使用者在不離開既有工作階段的前提下，閱讀任務、比較多位 NPC、管理工作室與直接輸入後續指令。

專業模式由既有 Focus Reader 演進，不另建第三套資料或工作流程。使用者不需要理解「專心閱讀」的概念；只需在頂端切換「像素／專業」。

## 2. 非目標

- 不保留亮色「現代模式」、3D 辦公室，或任何 `?theme=modern` 行為。
- 不建立可任意執行 shell 的網頁終端機。
- 不改變 NPC、任務、權限、工作區或 CLI session 的資料模型。
- 不把工具原始輸出預設塞進專業模式；此版維持既有專心閱讀的低干擾閱讀預設。

## 3. 使用者流程

```text
像素辦公室（預設）
  → 點頂欄「專業」
  → 進入同一個 NPC／工作區的全螢幕工作台
  → 可切換 NPC、工作室、部門、老闆交辦或分割閱讀窗格
  → 在底部繼續對目前 NPC 下指令
  → 點頂欄「像素」或按 Esc
  → 回到原本像素辦公室與選取的 NPC
```

### 行為規則

- 頂欄模式切換在兩種模式皆可見；它是唯一的模式入口與離開按鈕。
- 像素模式中的任務日誌不得再顯示「專心」入口或「進入專心閱讀模式」文案。
- 進入專業模式時保留目前 NPC，並依既有偏好還原分割窗格數量；手機一律一窗格。
- 離開專業模式時不丟失草稿、工作區、任務日誌寬度或選取的 NPC。
- Esc 保留為專業模式的快速回到像素模式；所有已開啟的子面板仍優先由 Esc 關閉。

## 4. 介面要求

### 頂欄切換

- 以明確的雙選項 segmented control 呈現「像素｜專業」，不可使用僅圖示按鈕。
- 當前模式具有可見的 active 狀態，並標示 `aria-pressed`。
- 進入專業模式後，頂欄保持在最上層；工作台內容從頂欄下方開始，避免重疊。

### 專業模式

- 將既有 Focus Reader、Focus Studios、Focus Pane Grid、Focus Controls、Focus Energy 和 composer 視為同一工作台。
- 所有面向使用者的標題與 aria label 使用「專業模式」或「專業工作台」，不再使用「專心閱讀」。
- 不新增額外設定精靈或新手必填選項；首次切換即可使用。

## 5. 移除範圍

下列現代模式專屬資產必須刪除：

- `web/src/theme.ts`
- `web/src/components/ModernWorkspace.tsx`
- `web/src/components/ModernWorkspace.css`
- `web/src/components/Office3D.tsx`
- `web/src/three/officeScene.ts`
- `web/test/officeSceneLifecycle.test.ts`
- 現代模式 CSS、TopBar theme 切換控制、相關 i18n 與 README 敘述

`three` 與 `@types/three` 仍由 QR 樹使用，不能因移除辦公室視圖而刪除。

仍被像素場景使用的 `dayNight.ts`、`stationTheme.ts` 與 `WebShotImg.tsx` 必須保留。

## 6. 驗收條件

- 頂欄在像素與專業模式皆呈現「像素｜專業」切換，且能進入／離開專業模式。
- 像素模式任務日誌沒有「專心」入口。
- 專業模式保留現有 NPC、部門、老闆交辦、工作室、分割窗格、用量、管理與指令輸入功能。
- 重新載入時，既有 `taskFocusMode` 偏好仍可讀取為專業模式，避免使用者被困在過期設定。
- 原始碼、測試、文件與 package lock 不再包含 modern theme、Office3D 或 ModernWorkspace；QR 樹既有的 Three.js 依賴不受影響。
- `npm test` 與 `npm run build` 成功。
