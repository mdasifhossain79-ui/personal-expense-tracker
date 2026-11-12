@echo off
cd /d "%~dp0"
title Personal Expense Tracker
where node >nul 2>nul
if errorlevel 1 goto nonode
if not exist node_modules\exceljs call npm install
powershell -NoProfile -Command "if((Test-NetConnection 127.0.0.1 -Port 3306 -WarningAction SilentlyContinue).TcpTestSucceeded){exit 0}else{exit 1}"
if errorlevel 1 (
  echo MySQL is not running. Trying to start it...
  for %%S in (MySQL80 MySQL MySQL57 MariaDB mysql) do net start %%S >nul 2>nul
  if exist "C:\xampp\mysql_start.bat" start "" /min "C:\xampp\mysql_start.bat"
  timeout /t 8 /nobreak >nul
)
start "" /min cmd /c "timeout /t 3 /nobreak >nul & start http://localhost:3005"
echo Personal Expense Tracker is running. Close this window to stop it.
node server.js
pause
exit /b
:nonode
echo Node.js is not installed. Get it from https://nodejs.org
pause
