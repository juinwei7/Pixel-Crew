@echo off
chcp 65001 >nul
rem ── Pixel Crew 遠端存取／手機控制 ──────────────────────────────
rem 雙擊即可：啟動轉接站（若尚未執行）並打開設定精靈。
rem 第一次會請你設定通行碼；之後在精靈裡選公開/私有、限時分享、開機自啟。
cd /d "%~dp0"

rem 若 8790 尚未在監聽，就啟動轉接站（隱藏視窗）
netstat -ano -p tcp | findstr /r /c:"127.0.0.1:8790 .*LISTENING" >nul 2>&1
if errorlevel 1 (
  echo 正在啟動轉接站…
  wscript "%~dp0_tsproxy_launch.vbs"
  rem 給它一點時間綁定連接埠
  ping -n 3 127.0.0.1 >nul
) else (
  echo 轉接站已在執行。
)

echo 開啟手機控制設定頁…
start "" "http://localhost:8790/"
