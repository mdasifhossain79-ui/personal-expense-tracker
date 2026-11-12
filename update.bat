@echo off
setlocal
cd /d "%~dp0"
if not exist update.zip (
  echo Put the new version here and name it update.zip first.
  pause
  exit /b 1
)
echo 1/5 Backing up your data...
node server.js --backup-now
if errorlevel 1 (
  echo The backup failed, so nothing was changed. Is MySQL running?
  pause
  exit /b 1
)
for /f %%t in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd-HHmmss"') do set STAMP=%%t
echo 2/5 Keeping a copy of the current program in previous-versions ...
if not exist previous-versions mkdir previous-versions
powershell -NoProfile -Command "Get-ChildItem -Force | Where-Object { $_.Name -notin 'node_modules','previous-versions','backups','receipts','update.zip' } | Compress-Archive -DestinationPath 'previous-versions\ledger-%STAMP%.zip' -Force"
echo 3/5 Checking the new version, then stopping the app and installing it...
if exist .update-temp rmdir /s /q .update-temp
powershell -NoProfile -Command "Expand-Archive -Path update.zip -DestinationPath .update-temp -Force"
set SRC=.update-temp
if exist .update-temp\expense-tracker\server.js set SRC=.update-temp\expense-tracker
if not exist "%SRC%\server.js" (
  echo update.zip does not look like a Personal Expense Tracker zip. Nothing was changed.
  if exist .update-temp rmdir /s /q .update-temp
  pause
  exit /b 1
)
for /f "tokens=5" %%p in ('netstat -ano ^| findstr :3000 ^| findstr LISTENING') do taskkill /PID %%p /F >nul 2>nul
timeout /t 2 /nobreak >nul
robocopy "%SRC%" "%~dp0." /E /XD node_modules backups receipts /XF db-config.json security.log server.log >nul
rmdir /s /q .update-temp
echo 4/5 Installing libraries...
call npm install --silent
ren update.zip update-done-%STAMP%.zip
echo 5/5 Done. Your data, settings and receipts were not touched.
call start.bat
