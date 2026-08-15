@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-lite.ps1" %*
if errorlevel 1 pause
