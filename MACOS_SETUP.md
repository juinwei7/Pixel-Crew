# Pixel Crew macOS 安裝教學

本文件適用於 Apple Silicon（M 系列）與 Intel Mac。Pixel Crew 是本機 Node.js
應用程式，不是 `.app`；啟動後請用瀏覽器開啟本機介面。

## 系統需求

- macOS
- Node.js 22.13.0 或更新版本
- Git
- Claude Code CLI 或 Codex CLI 至少其中一個
- 一個允許 Agent 操作的本機專案資料夾

先在「終端機」確認環境：

```bash
node --version
npm --version
git --version
uname -m
```

如果沒有 Node.js，請從 [Node.js 官方下載頁](https://nodejs.org/en/download)
安裝目前仍受支援、且版本不低於 22.13.0 的版本。若 `git --version` 觸發
Command Line Tools 安裝提示，依 macOS 畫面完成安裝後重新開啟終端機。

## 安裝 AI CLI

Pixel Crew 不接收 API key 或帳號密碼；登入狀態由官方 CLI 自己管理。也可以先
啟動 Pixel Crew，再使用首次啟動畫面中的官方安裝按鈕。

### Codex CLI

使用 OpenAI 官方 standalone installer：

```bash
curl -fsSL https://chatgpt.com/codex/install.sh | sh
codex --version
codex login
```

登入時依瀏覽器畫面完成 ChatGPT 驗證。可用下列指令確認狀態：

```bash
codex login status
```

最新安裝與登入方式請以 [Codex 官方文件](https://developers.openai.com/codex/)
為準。

### Claude Code CLI

使用 Anthropic 官方 native installer：

```bash
curl -fsSL https://claude.ai/install.sh | bash
claude --version
claude
```

也可以使用 Homebrew 的 stable channel：

```bash
brew install --cask claude-code
```

Claude Code 的 native installer 會自動更新；Homebrew 安裝則需自行執行
`brew upgrade claude-code`。最新安裝方式請以
[Claude Code 官方文件](https://code.claude.com/docs/en/quickstart)為準。

### 安裝完成但找不到指令

Codex 與 Claude 的 standalone installer 預設會把指令放在 `~/.local/bin`。
若終端機顯示 `command not found`，把它加入 macOS 預設 zsh 的 `PATH`：

```bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
```

再重新確認：

```bash
command -v codex
command -v claude
```

只需成功找到其中一個 provider 即可使用 Pixel Crew。

## 從 GitHub Release 安裝（一般使用者）

1. 從 [GitHub Releases](https://github.com/juinwei7/Pixel-Crew/releases) 下載
   `portable.zip` 或 `portable.tar.gz`，並一併下載 `SHA256SUMS.txt`。
2. 在下載資料夾驗證檔案；依下載格式選一個指令，輸出應顯示該檔案為 `OK`：

```bash
cd ~/Downloads

# ZIP
grep 'portable\.zip$' SHA256SUMS.txt | shasum -a 256 -c -

# 或 tar.gz
grep 'portable\.tar\.gz$' SHA256SUMS.txt | shasum -a 256 -c -
```

3. 解壓縮後，在終端機進入其中的 `pixel-crew` 資料夾。
4. 安裝 production dependencies：

```bash
cd /path/to/pixel-crew
npm install --omit=dev --workspace server --include-workspace-root
```

5. 啟動 Pixel Crew：

```bash
npm start
```

6. 保持終端機視窗開啟，另開瀏覽器前往 <http://127.0.0.1:8787>。也可以執行：

```bash
open http://127.0.0.1:8787
```

按 `Control+C` 可停止服務。Release 內容不是 macOS `.app`，通常不需要修改
Gatekeeper 設定，也不建議使用 `xattr -dr` 或停用系統安全功能。

## 從原始碼安裝（開發者）

```bash
git clone https://github.com/juinwei7/Pixel-Crew.git
cd Pixel-Crew
cp server/.env.example server/.env
npm install
```

Production 模式：

```bash
npm run build
npm start
open http://127.0.0.1:8787
```

需要前後端 hot reload 時使用開發模式：

```bash
npm run dev
open http://localhost:5173
```

`TARGET_REPO_PATH` 是選填。未設定時，第一次開啟會要求選擇工作資料夾；
macOS 可直接使用系統資料夾選擇器。若要固定預設房間，編輯 `server/.env`：

```dotenv
TARGET_REPO_PATH=/Users/name/Projects/my-repo
```

## 更新

### Release 安裝

下載新版本並解壓到新資料夾，再重新執行 production dependency 安裝與
`npm start`。NPC、對話索引、角色與設定預設保存在：

```text
~/Library/Application Support/Pixel Crew
```

因此替換程式資料夾不會刪除既有資料。確認新版正常後，再移除舊的程式資料夾。

### 原始碼安裝

```bash
git pull --ff-only
npm install
npm run build
npm start
```

先用 `Control+C` 停止舊服務，再啟動新版。

## 疑難排解

### `node` 版本太舊

```bash
node --version
which -a node
```

Pixel Crew 需要 Node.js 22.13.0 以上。若安裝新版後仍顯示舊版本，關閉所有
終端機視窗再重開，並檢查 `which -a node` 是否有多套 Node.js。

### Pixel Crew 找不到已安裝的 CLI

```bash
command -v claude
command -v codex
echo "$PATH"
```

請從同一個能找到 CLI 的終端機執行 `npm start`。若 CLI 位於
`~/.local/bin`，依上方 PATH 步驟加入 `~/.zshrc` 後重新啟動服務。

### Port 8787 已被占用

找出占用程式：

```bash
lsof -nP -iTCP:8787 -sTCP:LISTEN
```

可在 `server/.env` 改用另一個 loopback port：

```dotenv
PORT=8899
```

重新啟動後前往 <http://127.0.0.1:8899>。

### 資料夾選擇器沒有出現或無法存取專案

macOS 可能要求終端機存取 Desktop、Documents 或其他受保護資料夾。只授權
實際需要的專案位置；也可以在 Pixel Crew 中直接貼上專案的絕對路徑。若公司
政策禁止系統選擇器，手動輸入路徑仍可使用。

### 瀏覽器無法連線

確認執行 `npm start` 的終端機仍在運作，且輸出包含：

```text
pixel-crew server listening on http://127.0.0.1:8787
```

Pixel Crew 刻意只接受 localhost／loopback 連線，不能把 `HOST` 改成區域網路
位址。若需遠端使用，必須先另外設計認證、TLS 與來源限制。

## 移除

先停止 Pixel Crew，再刪除程式資料夾。若也要刪除本機 NPC、對話索引、角色與
設定，可在確認不需要備份後，於 Finder 前往下列資料夾並移到垃圾桶：

```text
~/Library/Application Support/Pixel Crew
```

Claude Code 與 Codex CLI 是獨立安裝的工具，不會隨 Pixel Crew 一起移除。
