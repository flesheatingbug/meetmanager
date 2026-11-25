@echo off
rem Opens XC Meet Manager in its own window (Microsoft Edge app mode, or Chrome).
setlocal EnableDelayedExpansion
set "APP=%~dp0XC-Meet-Manager.html"
set "URL=file:///!APP:\=/!"
set "URL=!URL: =%%20!"
set "PROFILE=%LOCALAPPDATA%\XCMeetManager\BrowserProfile"
set "ARGS=--app="!URL!" --user-data-dir="!PROFILE!" --no-first-run --no-default-browser-check --window-size=1400,900"

for %%B in (
  "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
  "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
  "%LOCALAPPDATA%\Microsoft\Edge\Application\msedge.exe"
  "%ProgramFiles%\Google\Chrome\Application\chrome.exe"
  "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
  "%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"
) do (
  if exist "%%~B" (
    start "" "%%~B" !ARGS!
    exit /b 0
  )
)
rem No Edge/Chrome found: open in the default browser instead.
start "" "%APP%"
