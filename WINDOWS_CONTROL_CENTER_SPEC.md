# Pixel Crew Windows 控制中心規格

狀態：實作完成，待 Windows 實機驗收
範圍：Windows x64 單檔 `Pixel Crew.exe`；不安裝 Windows Service、不要求系統管理員權限。

## 問題與目標

目前 Windows 版透過隱藏的 PowerShell 與 Node.js 啟動。這能執行服務，但使用者在工作管理員、系統匣與錯誤處理上看不到一致的 Pixel Crew 身分。

Windows 對外提供一個原生、self-contained 的 `Pixel Crew.exe`。首次執行後，它會私下安裝到 `%LOCALAPPDATA%\\Pixel Crew\\app`；已安裝的 EXE 是使用者的控制中心，也是內附 `runtime\\node.exe` 的生命週期擁有者。單檔 bootstrap 行為另見 `WINDOWS_SINGLE_FILE_RELEASE_SPEC.md`。

## 驗收情境

### 啟動與身分

- 使用者雙擊唯一下載的 `Pixel Crew.exe` 時，工作管理員顯示 `Pixel Crew.exe`，而非常駐的 PowerShell 視窗。
- 控制中心從 `%LOCALAPPDATA%\\Pixel Crew\\app\\runtime\\node.exe` 啟動 `server\\dist\\index.js --serve-web`，工作目錄為已安裝 app 目錄。
- 控制中心只聆聽與開啟 `http://127.0.0.1:<port>`；預設連接埠是 `8787`。
- 第二次啟動只喚回既有控制中心，不會建立第二個 Node 服務。

### 系統匣與視窗

- 控制中心使用 Pixel Crew 的內嵌圖示建立系統匣項目，並在圖示提示顯示目前狀態。
- 右鍵選單提供：`開啟`、`重新啟動`、`停止`、`查看記錄`、`開機自動啟動`、`結束控制中心…`。
- `開啟` 顯示控制中心並可開啟 Web UI；雙擊系統匣圖示也會顯示控制中心。
- 控制中心被關閉時必須讓使用者選擇：`只關閉圖示`（Node 繼續執行）或 `停止服務並結束`。取消則維持開啟。

### 錯誤與記錄

- 控制中心啟動失敗或其擁有的 Node 程序意外結束時，顯示含原因的 Windows 通知與錯誤對話框。
- 錯誤對話框包含 `查看詳細資料`，可開啟 `%LOCALAPPDATA%\\Pixel Crew\\logs`；標準輸出與標準錯誤分別寫入 `server.stdout.log`、`server.stderr.log`。
- 使用者明確按下停止或選擇停止後結束時，不視為意外錯誤。

### 開機自動啟動與權限

- `開機自動啟動` 僅使用目前使用者的 `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run`，指向帶有 `--minimized` 的控制中心；不得要求提升權限。
- 選單核取狀態反映目前設定，切換後立即寫入或移除該值。

### 發佈與相容性

- Windows 打包在 Windows x64 CI 中以 .NET 8 self-contained single-file 方式輸出唯一的 `Pixel Crew.exe` Release 資產。
- 下載 EXE 不附帶可見的控制中心原始碼、.NET SDK、VBS/CMD 啟動器或 PowerShell 系統匣控制器。
- 若控制中心或內附 Node runtime 不存在，顯示可理解錯誤與記錄位置。

## 非目標

- 不註冊 Windows Service、排程工作或機器層級 Registry。
- 不取得管理員權限。
- 不管理非控制中心所啟動的既有 Node 程序；若偵測到相同埠已被健康的 Pixel Crew 使用，控制中心會連到它但不會強制終止該程序。
- 不使用需要 MSIX／商店註冊的 Windows Toast action。錯誤通知以系統匣氣泡與可操作的原生錯誤對話框提供。

## 驗證

- 靜態測試驗證專案目標、必要選單與 Registry 範圍，以及 Windows packager 會產出並稽核 `Pixel Crew.exe`。
- Windows CI 打包後確認發佈目錄只含 `Pixel Crew.exe`；實機首次執行後確認 AppData 內含 runtime 與產品內容。
- 實機 Windows smoke test：啟動、停止、重啟、登入自啟、錯誤詳細資料與關閉選擇。
