# Pixel Crew macOS 安裝教學

本文件適用於 Apple Silicon（M 系列）與 Intel Mac。一般使用者安裝後會得到
`Pixel Crew.app`；它會在 menu bar 執行本機服務並自動開啟瀏覽器介面。

## 系統需求

- macOS 11 或更新版本
- 一個允許 Agent 操作的本機專案資料夾

一般安裝**不需要**預先安裝 Node.js、npm、Git、Homebrew 或 Xcode。Pixel Crew
會依 Apple Silicon／Intel 自動下載內含 Node runtime 的版本。Claude Code CLI
或 Codex CLI 也可以在首次啟動畫面再安裝。

## 一行安裝（一般使用者）

打開「終端機」，貼上這一行：

```bash
curl -fsSL https://github.com/juinwei7/Pixel-Crew/releases/latest/download/install-pixel-crew-macos.sh | /bin/bash
```

installer 會偵測 CPU 架構、下載對應 release、核對 SHA-256，然後安裝到：

```text
~/Applications/Pixel Crew.app
```

完成後會自動啟動。之後可直接從 Finder 的個人 `Applications` 資料夾或
Spotlight 開啟，不必再執行終端機指令。Pixel Crew 會出現在 menu bar；選單可
重新開啟介面、查看 log 或完整退出服務。

目前 maintainer 沒有 Apple Developer ID，因此這是**未經 Apple notarization
的 certificate-free build**。installer 透過 GitHub HTTPS 取得檔案並在解壓前
驗證 release checksum；它不使用 `sudo`，也不會停用 Gatekeeper 或修改系統安全
設定。

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

## 從 GitHub Release 手動安裝

如果不想使用 pipe，可從 [GitHub Releases](https://github.com/juinwei7/Pixel-Crew/releases)
下載 `install-pixel-crew-macos.sh`，再執行：

```bash
bash ~/Downloads/install-pixel-crew-macos.sh
```

腳本會自行下載 `pixel-crew-macos-arm64.tar.gz` 或
`pixel-crew-macos-x64.tar.gz` 及 `SHA256SUMS.txt`，只在驗證成功後才替換 app。

## 從原始碼安裝（開發者）

只有原始碼開發模式需要 Node.js 22.13.0 以上與 Git。請先從
[Node.js 官方下載頁](https://nodejs.org/en/download)準備環境，再執行：

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

重新執行一行安裝指令即可升級。installer 會先完整驗證新版，再替換既有 app。
NPC、對話索引、角色與設定預設保存在：

```text
~/Library/Application Support/Pixel Crew
```

因此升級 app 不會刪除既有資料。

### 原始碼安裝

```bash
git pull --ff-only
npm install
npm run build
npm start
```

先用 `Control+C` 停止舊服務，再啟動新版。

## 疑難排解

### 原始碼開發時 `node` 版本太舊

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

一般 `.app` 啟動器會自動搜尋 `~/.local/bin`、`/opt/homebrew/bin` 與
`/usr/local/bin`。若仍找不到 CLI，先完全退出 menu bar 的 Pixel Crew，確認
上述 `command -v` 有結果後再重新開啟。

### Port 8787 已被占用

找出占用程式：

```bash
lsof -nP -iTCP:8787 -sTCP:LISTEN
```

一般 `.app` 固定使用 loopback port 8787；請先退出占用該 port 的舊 Pixel Crew
或其他程式。原始碼開發模式才可在 `server/.env` 改用另一個 port：

```dotenv
PORT=8899
```

重新啟動後前往 <http://127.0.0.1:8899>。

### 資料夾選擇器沒有出現或無法存取專案

macOS 可能要求終端機存取 Desktop、Documents 或其他受保護資料夾。只授權
實際需要的專案位置；也可以在 Pixel Crew 中直接貼上專案的絕對路徑。若公司
政策禁止系統選擇器，手動輸入路徑仍可使用。

### 瀏覽器無法連線

從 menu bar 的 Pixel Crew 選單點擊 `Open Log`。正常啟動時 log 會包含：

```text
pixel-crew server listening on http://127.0.0.1:8787
```

Pixel Crew 刻意只接受 localhost／loopback 連線，不能把 `HOST` 改成區域網路
位址。遠端／手機使用請走內建的「手機連線」轉接站（見下節），它自帶登入關卡，
不會把無認證的本體直接暴露到網路上。

## 手機連線（遠端存取）

macOS 版與 Windows 版功能相同：在 Pixel Crew 介面開啟「手機連線」面板，
啟動轉接站後可選兩種對外通道：

- **免安裝通道（Cloudflare Tunnel）**：點「下載」會自動抓對應 CPU 架構的
  `cloudflared`（Apple Silicon／Intel 皆支援；若已用 `brew install cloudflared`
  安裝也會自動偵測）。啟動後拿到一組 `https://…trycloudflare.com` 網址，
  手機免裝任何東西，開網址輸入通行碼即可。網址每次重啟會變。
- **Tailscale（固定網址・較私密）**：安裝
  [Tailscale](https://tailscale.com/download) 並登入即可，官方 App 內建的
  CLI（`/Applications/Tailscale.app` 內）會被自動偵測，不需手動設定 PATH。

「開機自動啟動轉接站」在 macOS 透過 `~/Library/LaunchAgents` 的 launchd
設定實現，開關都在同一個面板，下次登入起生效。

首次啟動轉接站時，需在**這台 Mac 本機**開啟設定精靈設定主通行碼；遠端
一律要求登入，通行碼與密鑰存在安裝目錄的 `_tsproxy.secret.json`，不會進
版本控制。

## 移除

只移除 app 並保留資料：

```bash
curl -fsSL https://github.com/juinwei7/Pixel-Crew/releases/latest/download/install-pixel-crew-macos.sh | /bin/bash -s -- --uninstall
```

若也要刪除本機 NPC、對話索引、角色與設定，可在確認不需要備份後，於 Finder
前往下列資料夾並移到垃圾桶：

```text
~/Library/Application Support/Pixel Crew
```

Claude Code 與 Codex CLI 是獨立安裝的工具，不會隨 Pixel Crew 一起移除。
