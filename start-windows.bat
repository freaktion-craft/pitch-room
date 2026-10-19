@echo off
rem Pitch Room - Windows: double-click to start. First run sets up Python packages (1-2 min).
chcp 65001 >nul
cd /d "%~dp0"

set "PY="
where py >nul 2>&1 && py -3 -c "import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)" >nul 2>&1 && set "PY=py -3"
if not defined PY (
  where python >nul 2>&1 && python -c "import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)" >nul 2>&1 && set "PY=python"
)
if not defined PY (
  echo Python 3.9 or newer is needed. Opening the download page.
  echo When installing, tick "Add python.exe to PATH", then run this file again.
  start "" "https://www.python.org/downloads/windows/"
  pause
  exit /b 1
)

if not exist ".venv\Scripts\python.exe" (
  echo First run: creating a private Python environment...
  %PY% -m venv .venv
  if errorlevel 1 (
    echo Could not create the environment.
    pause
    exit /b 1
  )
)

".venv\Scripts\python.exe" launch.py %*
if errorlevel 1 pause
