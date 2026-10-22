@echo off
rem Stem - Windows: double-click to start. First run sets up Python packages (1-2 min).
chcp 65001 >nul
cd /d "%~dp0"

if exist ".venv\Scripts\python.exe" goto run

set "PY="
where py >nul 2>&1 && py -3 -c "import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)" >nul 2>&1 && set "PY=py -3"
if not defined PY (
  where python >nul 2>&1 && python -c "import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)" >nul 2>&1 && set "PY=python"
)
if defined PY (
  echo First run: creating a private Python environment...
  %PY% -m venv .venv
  if errorlevel 1 goto noenv
  goto run
)

rem No Python 3.9+ on this PC: uv (astral.sh) fetches one for Stem alone, into .tools; nothing outside this folder changes
echo First run: Python isn't installed, so Stem fetches its own copy (about 40 MB, once)...
set "UV_PYTHON_INSTALL_DIR=%CD%\.tools\python"
set "UV_CACHE_DIR=%CD%\.tools\cache"
if not exist ".tools\uv.exe" powershell -NoProfile -ExecutionPolicy Bypass -Command "$ProgressPreference = 'SilentlyContinue'; $a = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'aarch64' } else { 'x86_64' }; Invoke-WebRequest \"https://github.com/astral-sh/uv/releases/download/0.12.24/uv-$a-pc-windows-msvc.zip\" -OutFile .tools-uv.zip; Expand-Archive .tools-uv.zip .tools -Force; Remove-Item .tools-uv.zip"
if not exist ".tools\uv.exe" (
  echo Couldn't fetch Python. Check the internet connection and run this again, or install Python 3.9 or newer from python.org.
  pause
  exit /b 1
)
".tools\uv.exe" venv --seed --managed-python --python 3.11 .venv
if errorlevel 1 goto noenv

:run
".venv\Scripts\python.exe" launch.py %*
if errorlevel 1 pause
exit /b

:noenv
echo Could not create the environment.
pause
exit /b 1
