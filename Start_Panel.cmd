@echo off
setlocal
pushd "%~dp0" >nul 2>nul
if errorlevel 1 (
  echo Unable to open the project directory.
  if /i not "%~1"=="--check" pause
  exit /b 1
)
where node >nul 2>nul
if errorlevel 1 goto missing_node
where npm.cmd >nul 2>nul
if errorlevel 1 goto missing_node
node -e "if (Number(process.versions.node.split('.')[0]) < 22) process.exit(1)"
if errorlevel 1 goto missing_node
rem Check mandatory packages in this clone, including their entry points.
node -e "const fs = require('node:fs'); for (const name of Object.keys(require('./package.json').dependencies)) { if (!fs.existsSync('node_modules/' + name + '/package.json')) process.exit(1); require(name); }" >nul 2>nul
if errorlevel 1 goto missing_dependencies
if /i "%~1"=="--check" (
  echo Panel launcher prerequisites passed.
  popd
  exit /b 0
)
echo Starting the local configuration panel. Keep this window open; Ctrl+C stops it.
call npm.cmd run panel
set "panel_exit=%errorlevel%"
if errorlevel 1 pause
popd
exit /b %panel_exit%
:missing_dependencies
echo Required packages are missing or damaged. Open this folder in a terminal and run npm ci.
goto failed
:missing_node
echo Install Node.js 22 or newer, including npm, then reopen this launcher.
:failed
if /i not "%~1"=="--check" pause
popd
exit /b 1
