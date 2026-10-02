@echo off
cd /d "%~dp0.."
if not exist "dist\src\cli.js" (
  echo Build missing. Run: npx pnpm@10.33.1 build
  exit /b 1
)
:restart
node "dist\src\cli.js"
if not errorlevel 1 exit /b 0
echo Bot exited with error. Restarting in 2 seconds...
timeout /t 2 /nobreak >nul
goto restart
