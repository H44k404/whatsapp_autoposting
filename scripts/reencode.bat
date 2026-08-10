@echo off
REM Wrapper for Windows: calls the PowerShell re-encode script
if "%~1"=="" (
  echo Usage: reencode.bat "C:\path\to\input.file"
  exit /b 1
)
powershell -ExecutionPolicy Bypass -File "%~dp0reencode.ps1" -InputPath "%~1"
