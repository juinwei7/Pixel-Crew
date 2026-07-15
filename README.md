# Pixel Crew

A local multi-agent cockpit for Claude Code.

本機的「跟 Claude 聊天做事」web 介面。後端把使用者輸入轉成 Claude Code CLI 的 headless 呼叫
(`claude -p ... --output-format stream-json`),把串流事件正規化後用 WebSocket 推給前端即時渲染
(文字、工具呼叫卡片、驗證結果)。**執行工作的其實還是 Claude Code CLI 本身**——這個 app 只是
一個殼,沿用你本機已登入的訂閱,不必另外接 API key 計費。

## 需求

- Node.js 22.5+（使用內建 SQLite；這台機器目前為 Node 26）
- 已登入的 `claude` CLI(`claude auth` 或 `claude setup-token`),且 PATH 裡找得到 `claude`
- 一個你想讓 Claude 操作的目標 repo(v1 只支援固定一個)

## 安裝 Node

```bash
brew install node
```

## 安裝與啟動

```bash
cd server && cp .env.example .env   # 編輯 TARGET_REPO_PATH 指向你的目標 repo
cd ../web && cp .env.example .env
cd ..
npm install
npm run dev
```

- 後端:http://localhost:8787
- 前端:http://localhost:5173

## 使用

在網頁輸入框下達工作指令，Claude 會在目標 repo 裡使用可用工具完成任務。具體工作流程可寫在
目標 repo 的 `.claude/commands/` 與 `CLAUDE.md`，不是寫死在這個 app 裡，因此切換 repo 時也能
沿用各專案自己的指令與規範。

## 已知限制 / 之後可以做的

- v1 只綁一個固定 `TARGET_REPO_PATH`,不支援對話中途切換 repo。
- 權限模式預設 `acceptEdits`(自動放行 Edit/Write 類工具呼叫),`.env` 的 `PERMISSION_MODE`
  可以調整;更保守或更寬鬆都是你的選擇,調整前想清楚安全性取捨。
- 本機 SQLite 會保存 worker、事件歷史與「web session ↔ claude session」對應；預設資料庫在
  `server/data/cockpit.sqlite`，可用 `DB_PATH` 覆寫。目前沒有跨裝置同步。
