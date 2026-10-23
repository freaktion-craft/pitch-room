@echo off
rem Stem - Windows: double-click to update Stem to the latest version (close Stem first).
chcp 65001 >nul
cd /d "%~dp0.."
if not exist ".venv\Scripts\python.exe" (
  echo Start Stem once first ^(start-windows.bat^), then run this again.
  pause
  exit /b 1
)
rem on one line: cmd reads a batch file as it goes, and the update may write over this one
".venv\Scripts\python.exe" update.py & pause & exit /b
