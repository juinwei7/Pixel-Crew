# Windows 單檔發佈規格

狀態：實作完成，待 Windows 實機驗收
取代：面向使用者的 Windows ZIP／`start-pixel-crew.vbs` 啟動流程。

## 產品決策

Windows 對外只發佈一個檔案：`Pixel Crew.exe`。使用者只需下載並雙擊它；不需要解壓 ZIP、挑選 VBS/CMD、安裝 Node.js，或辨識 runtime 資料夾。

這個檔案是 self-contained 的 .NET 8 WinForms bootstrapper 與控制中心。它以嵌入式 payload 帶著驗證過的 Node.js runtime、production server 與 web build，首次執行時安裝到目前使用者的 `%LOCALAPPDATA%\\Pixel Crew\\app`，再從該位置啟動同一個 `Pixel Crew.exe`。

## 驗收情境

### 唯一使用者路徑

- GitHub Release 的 Windows 下載項目只有 `Pixel Crew.exe`；不再向一般使用者提供 Windows ZIP、`.vbs` 或 `.cmd` 入口。
- 使用者下載後只需雙擊 `Pixel Crew.exe`。首次啟動不要求管理員權限，也不要求另行安裝 .NET、Node.js、npm 或 Git。
- 下載位置只保存可刪除的單一 EXE；應用程式檔案安裝在目前使用者 AppData，不把 runtime 檔案散落於下載資料夾。

### 安裝與啟動

- bootstrapper 將嵌入的 `payload.zip` 解壓到同磁碟的 staging 目錄，加入自身 EXE，然後以目錄交換完成安裝，避免半成品 app 目錄。
- 後續由已安裝的 `Pixel Crew.exe` 管理內附 `runtime\\node.exe` 與系統匣。其行為遵循 `WINDOWS_CONTROL_CENTER_SPEC.md`。
- 已安裝控制中心再次被啟動時只喚回既有視窗，不建立第二個 Node 服務。
- 開機自動啟動登錄項永遠指向 AppData 內已安裝的 EXE，不指向 Downloads。

### 發佈組成

- 打包先組出私有 payload（runtime、server、web、必要更新工具），再把 payload 作為 managed resource 嵌入 `Pixel Crew.exe`。
- 最終發佈目錄只允許一個 `Pixel Crew.exe`；payload staging 與 ZIP 不得留在發佈品。
- Windows CI 在 Windows x64 runner 上產出該單一 EXE，並在封裝前驗證 payload 與 EXE 的存在。

### 失敗處理

- 解壓／目錄交換失敗時，顯示清楚錯誤及 logs 位置，且保留原有已安裝版本。
- 若現有控制中心或其 Node 服務仍在執行，第二次點擊只開啟既有控制中心；更新流程不得悄悄覆蓋正在執行的檔案。

## 非目標

- 不製作 Windows Service、MSI 或機器層級安裝程式。
- 不要求管理員權限或寫入 Program Files。
- 不承諾避開未簽章 EXE 的 Microsoft SmartScreen 警示；這需要後續程式碼簽章。

## 驗證

- 靜態測試確認 project 有 payload resource、bootstrapper 使用 LocalApplicationData 與 staging、packager 最終只留下 EXE。
- Windows CI smoke test：從乾淨使用者 profile 雙擊 EXE、確認 AppData 安裝、系統匣與 `node.exe` 啟動。
