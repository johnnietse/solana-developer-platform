@echo off
rem Double-click to bring the whole Solana Developer Platform up, then open the
rem dashboard. Safe to run when everything is already up: each step checks
rem before acting. The work is in scripts/start-all.sh.
cd /d "%~dp0"
"C:\Program Files\Git\bin\bash.exe" scripts/start-all.sh
if %errorlevel% neq 0 (
  echo.
  echo Startup reported a problem - read the lines above.
  pause
  exit /b 1
)
start "" http://localhost:3002
timeout /t 8
