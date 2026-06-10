@echo off
setlocal
cd /d "%~dp0"

echo ========================================
echo   Starting YT Live Camera Dashboard...
echo   URL: http://localhost:8100
echo   Console: http://localhost:8100/console
echo ========================================

:: Check if virtual environment exists
if not exist ".venv\Scripts\python.exe" (
    echo [ERROR] Virtual environment not found at .venv\
    pause
    exit /b
)

:: Run the application
".venv\Scripts\python.exe" main.py

if %errorlevel% neq 0 (
    echo.
    echo [ERROR] Application crashed or stopped unexpectedly.
    pause
)

endlocal
