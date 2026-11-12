@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 exit /b 1
if not exist node_modules\exceljs call npm install >> server.log 2>&1
powershell -NoProfile -Command "if((Test-NetConnection 127.0.0.1 -Port 3306 -WarningAction SilentlyContinue).TcpTestSucceeded){exit 0}else{exit 1}"
if errorlevel 1 (
  for %%S in (MySQL80 MySQL MySQL57 MariaDB mysql) do net start %%S >nul 2>nul
  if exist "C:\xampp\mysql_start.bat" start "" /min "C:\xampp\mysql_start.bat"
  timeout /t 8 /nobreak >nul
)
node server.js >> server.log 2>&1
