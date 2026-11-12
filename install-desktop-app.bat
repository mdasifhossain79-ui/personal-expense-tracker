@echo off
setlocal
cd /d "%~dp0"
echo This puts a "Personal Expense Tracker" icon on your Desktop. It opens the app in its own window, with no
echo browser tabs and no black console window, and starts the server by itself.
echo.
powershell -NoProfile -ExecutionPolicy Bypass -Command "$s=(New-Object -ComObject WScript.Shell).CreateShortcut([Environment]::GetFolderPath('Desktop')+'\Personal Expense Tracker.lnk'); $s.TargetPath='wscript.exe'; $s.Arguments='\"%~dp0expense-tracker-app.vbs\"'; $s.WorkingDirectory='%~dp0'; $s.IconLocation='%~dp0icon.ico'; $s.Save()"
echo Desktop icon created.
echo.
choice /m "Also open Personal Expense Tracker automatically when Windows starts"
if errorlevel 2 goto done
powershell -NoProfile -ExecutionPolicy Bypass -Command "$s=(New-Object -ComObject WScript.Shell).CreateShortcut([Environment]::GetFolderPath('Startup')+'\Personal Expense Tracker.lnk'); $s.TargetPath='wscript.exe'; $s.Arguments='\"%~dp0expense-tracker-app.vbs\"'; $s.WorkingDirectory='%~dp0'; $s.IconLocation='%~dp0icon.ico'; $s.Save()"
echo Personal Expense Tracker will now start with Windows. Delete "Personal Expense Tracker" from the Startup folder to undo this.
:done
echo.
pause
