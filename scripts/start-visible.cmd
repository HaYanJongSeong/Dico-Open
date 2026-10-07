@echo off
cd /d "%~dp0.."
if not exist "dist\src\cli.js" (
  echo Build missing. Run: npx pnpm@10.33.1 build
  exit /b 1
)
setlocal
set "DICO_SHELL=powershell.exe"
where pwsh.exe >nul 2>nul
if not errorlevel 1 set "DICO_SHELL=pwsh.exe"
where wt.exe >nul 2>nul
if errorlevel 1 goto powershell
wt.exe -w 0 new-tab --title "Dico-Open" --startingDirectory "%CD%" %DICO_SHELL% -NoLogo -NoProfile -NoExit -ExecutionPolicy Bypass -File "%~dp0start-visible.ps1"
if not errorlevel 1 exit /b 0
:powershell
start "Dico-Open" %DICO_SHELL% -NoLogo -NoProfile -NoExit -ExecutionPolicy Bypass -File "%~dp0start-visible.ps1"
exit /b %ERRORLEVEL%
