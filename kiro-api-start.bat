@echo off
REM Kiro API Startup Script for Windows

cd /d "%~dp0"

echo Starting Kiro API...
echo.

REM Check if bun is installed
where bun >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo Error: Bun is not installed.
    echo Please install Bun first: https://bun.sh
    echo.
    pause
    exit /b 1
)

REM Install dependencies if needed
if not exist "node_modules" (
    echo Installing dependencies...
    bun install
    echo.
)

REM Start the server
bun run start

REM Keep terminal open on error
pause

