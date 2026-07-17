# Pixel Crew Windows 安裝教學

Pixel Crew 支援原生 Windows 10 22H2 x64 與 Windows 11 x64。Windows 11 是 Codex 原生沙箱的建議環境；完整更新的 Windows 10 可使用，但 Codex 官方將其列為 best-effort。

## 最快方式：使用 Release ZIP

1. 從 GitHub Releases 下載 `pixel-crew-windows-x64.zip`，並解壓縮到一般使用者可寫入的目錄，例如：

   ```text
   C:\Users\你的名字\Apps\Pixel Crew
   ```

2. 確認已安裝 Node.js 22.13+：

   ```powershell
   winget install OpenJS.NodeJS.LTS
   ```

3. 至少安裝一個 AI CLI：

   ```powershell
   # Claude Code
   winget install Anthropic.ClaudeCode

   # Codex
   npm install -g @openai/codex
   ```

4. 雙擊 `install-pixel-crew.cmd`。它只安裝 Pixel Crew 的 production dependencies，不會要求或保存 AI 帳號密碼。
5. 雙擊 `start-pixel-crew.cmd`。視窗需保持開啟，瀏覽器會自動前往 <http://127.0.0.1:8787>。
6. 第一次進入後點上方房間名稱，使用 Windows 原生資料夾選擇器選擇 repository。
7. 如果 CLI 還沒登入，依介面提示在 PowerShell 執行：

   ```powershell
   claude auth login
   # 或
   codex login
   ```

## 從原始碼一鍵安裝

先安裝 Git 與 Node.js：

```powershell
winget install Git.Git
winget install OpenJS.NodeJS.LTS
```

下載並建置：

```powershell
git clone https://github.com/juinwei7/Pixel-Crew.git
cd Pixel-Crew
scripts\windows\setup-windows.cmd
start-pixel-crew.cmd
```

也可讓 setup 一併安裝 provider CLI：

```powershell
scripts\windows\setup-windows.cmd -InstallClaude -InstallCodex
```

## 更新

原始碼安裝：

```powershell
git pull
scripts\windows\setup-windows.cmd
```

Release ZIP：下載新版、解壓到新目錄、執行 `install-pixel-crew.cmd`。NPC、對話索引與角色資料保存在 `%LOCALAPPDATA%\Pixel Crew`，不會因替換程式目錄而消失。

## 環境診斷

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows\doctor.ps1
```

Doctor 會檢查 Windows、Node、npm、Git、Claude Code、Codex 與實際執行檔位置，不會輸出 token。

## Windows 10 注意事項

- 必須是 64-bit Windows 10 22H2，並安裝所有系統更新。
- Claude Code 官方支援 Windows 10 1809+；Git for Windows 是建議依賴，沒有 Git Bash 時會退回 PowerShell。
- Codex 官方要求現代 Windows console/ConPTY；Windows 10 屬 best-effort。若 sandbox 初始化持續失敗，優先升級 Windows 11，不要為了繞過錯誤直接開 full access。
- 第一版只接受本機磁碟路徑。UNC、網路磁碟與 `\\wsl$\...` 會被拒絕，避免 session、MCP 與 sandbox 對同一路徑產生不一致判斷。

官方參考：

- [Claude Code Windows 安裝](https://code.claude.com/docs/en/installation)
- [Codex Windows sandbox](https://learn.chatgpt.com/docs/windows/windows-sandbox)

## 常見問題

### 找不到 `claude` 或 `codex`

安裝 CLI 後關閉所有 PowerShell/Pixel Crew 視窗再重開，讓 PATH 更新。再執行 `scripts\windows\doctor.ps1`。

### `claude` 開到 Claude Desktop

舊版 Claude Desktop 可能讓 WindowsApps 中的 `Claude.exe` 排在 CLI 前面。更新 Claude Desktop，並用 Doctor 確認實際路徑。

### 資料夾選擇器沒有出現

Server 必須由互動式桌面帳號啟動。若公司政策阻止 PowerShell WinForms，仍可在欄位貼上完整路徑，例如：

```text
C:\Users\name\Projects\my-repo
```

### Port 8787 被占用

```powershell
start-pixel-crew.cmd -Port 8899
```

### 如何完整移除

刪除 Pixel Crew 程式目錄即可移除程式。若也要刪除所有 NPC、對話索引與角色資料，再刪除：

```text
%LOCALAPPDATA%\Pixel Crew
```

刪除前請先備份 `cockpit.sqlite`。
