@echo off
:: SQL Pulse — one-click installer wrapper
:: Extract the entire ZIP first. Prerequisites may request administrator approval.
setlocal

echo.
echo Starting SQL Pulse installer...
echo.

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
set "INSTALL_EXIT=%errorlevel%"

echo.
if not "%INSTALL_EXIT%"=="0" (
    echo Install failed. Check the messages above.
    echo Extract the complete ZIP before running. Finish or cancel SQL work and stop SQL Pulse before upgrading.
    pause
) else (
    echo.
    pause
)
exit /b %INSTALL_EXIT%
