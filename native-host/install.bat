@echo off
setlocal enabledelayedexpansion

echo ================================================
echo     youDl Native Messaging Host Installer
echo ================================================

where node >nul 2>nul
if %ERRORLEVEL% neq 0 (
  echo [!] Node.js was not found in your PATH.
  echo     Please install Node.js from https://nodejs.org
  pause
  exit /b 1
)

set "HOST_NAME=com.youdl.helper"
set "DIR=%~dp0"
set "RUN_BAT=%DIR%run.bat"
set "RUN_BAT_ESCAPED=%RUN_BAT:\=\\%"

set "MANIFEST_CHROME=%DIR%com.youdl.helper.json"
set "MANIFEST_FIREFOX=%DIR%com.youdl.helper.firefox.json"

set "DEFAULT_EXT_ID=cfbkoncfgcphkmgapphbnmeooacnkfkc"
set "EXTRA_EXT_ID=%~1"

set "ORIGINS=\"chrome-extension://%DEFAULT_EXT_ID%/\""
if not "%EXTRA_EXT_ID%"=="" (
  if not "%EXTRA_EXT_ID%"=="%DEFAULT_EXT_ID%" (
    set "ORIGINS=%ORIGINS%, \"chrome-extension://%EXTRA_EXT_ID%/\""
  )
)

echo Generating Chromium manifest...
(
  echo {
  echo   "name": "%HOST_NAME%",
  echo   "description": "youDl local download helper",
  echo   "path": "%RUN_BAT_ESCAPED%",
  echo   "type": "stdio",
  echo   "allowed_origins": [
  echo     %ORIGINS%
  echo   ]
  echo }
) > "%MANIFEST_CHROME%"

echo Generating Firefox manifest...
(
  echo {
  echo   "name": "%HOST_NAME%",
  echo   "description": "youDl local download helper",
  echo   "path": "%RUN_BAT_ESCAPED%",
  echo   "type": "stdio",
  echo   "allowed_extensions": [
  echo     "youdl@local"
  echo   ]
  echo }
) > "%MANIFEST_FIREFOX%"

echo Registering in Windows Registry for Chrome, Brave, Edge, and Firefox...

REM Google Chrome
reg add "HKCU\Software\Google\Chrome\NativeMessagingHosts\%HOST_NAME%" /ve /t REG_SZ /d "%MANIFEST_CHROME%" /f >nul 2>nul
if %ERRORLEVEL% equ 0 echo   [+] Google Chrome registered.

REM Brave Browser
reg add "HKCU\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\%HOST_NAME%" /ve /t REG_SZ /d "%MANIFEST_CHROME%" /f >nul 2>nul
if %ERRORLEVEL% equ 0 echo   [+] Brave Browser registered.

REM Microsoft Edge
reg add "HKCU\Software\Microsoft\Edge\NativeMessagingHosts\%HOST_NAME%" /ve /t REG_SZ /d "%MANIFEST_CHROME%" /f >nul 2>nul
if %ERRORLEVEL% equ 0 echo   [+] Microsoft Edge registered.

REM Mozilla Firefox
reg add "HKCU\Software\Mozilla\NativeMessagingHosts\%HOST_NAME%" /ve /t REG_SZ /d "%MANIFEST_FIREFOX%" /f >nul 2>nul
if %ERRORLEVEL% equ 0 echo   [+] Mozilla Firefox registered.

echo.
echo ================================================
echo [OK] youDl Native Messaging Host is installed!
echo.
echo   Next steps:
echo   1. Open Chrome, Brave, Edge, or Firefox.
echo   2. Reload the youDl extension.
echo   3. youDl is now connected natively!
echo ================================================
echo.
pause
