@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 goto missing_node
where npm.cmd >nul 2>nul
if errorlevel 1 goto missing_node
node -e "if (Number(process.versions.node.split('.')[0]) < 22) process.exit(1)"
if errorlevel 1 goto missing_node
if not exist "node_modules\" (
  echo Dependencies are missing. Open this folder in a terminal and run npm ci first.
  if /i not "%~1"=="--check" pause
  exit /b 1
)
if /i "%~1"=="--check" (
  echo Panel launcher prerequisites passed.
  exit /b 0
)
echo Starting the local configuration panel. Keep this window open; Ctrl+C stops it.
call npm run panel
if errorlevel 1 pause
exit /b %errorlevel%
:missing_node
echo Install Node.js 22 or newer, including npm, then reopen this launcher.
if /i not "%~1"=="--check" pause
exit /b 1
