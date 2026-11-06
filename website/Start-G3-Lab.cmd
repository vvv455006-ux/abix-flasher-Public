@echo off
setlocal
set "LAB=%~dp0server\emulator_core"
if not exist "%LAB%\.venv\Scripts\python.exe" (
    echo The G3 Lab Python environment is missing.
    echo See server\emulator_core\README.txt for setup.
    pause
    exit /b 1
)
"%LAB%\.venv\Scripts\python.exe" -B "%LAB%\ble_lab.py" gui
if errorlevel 1 pause

