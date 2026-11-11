@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js not found. Install it from https://nodejs.org and run again.
  pause
  exit /b 1
)

if not exist node_modules\terser (
  echo Installing build dependencies...
  call npm install --no-audit --no-fund
  if errorlevel 1 goto :fail
)

echo Building extension...
node build.mjs
if errorlevel 1 goto :fail

echo.
echo Done. Upload ai-elit-extension.zip to the Chrome Web Store.
pause
exit /b 0

:fail
echo.
echo BUILD FAILED
pause
exit /b 1
