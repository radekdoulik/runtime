@echo off
rem Licensed to the .NET Foundation under one or more agreements.
rem The .NET Foundation licenses this file to you under the MIT license.
rem
rem serve-smokes.cmd — prepare + serve the browser smoke harness, launch
rem Chrome with --remote-debugging-port=9222 on the smoke index, and
rem start cdp-driver.mjs in watch mode so the async-break demo runs
rem automatically when the user clicks the hello-async-break link.
rem
rem Usage:
rem   serve-smokes.cmd                  Serve + chrome + watcher
rem   serve-smokes.cmd --just-serve     Serve only; no chrome / no watcher
rem   serve-smokes.cmd [--port=8080] [--skip-prepare] [--cdp-port=9222] [--browser=chrome^|edge] [--keep-profile]

setlocal enabledelayedexpansion

set "PORT=8080"
set "CDP_PORT=9222"
set "BROWSER="
set "SKIP_PREPARE=0"
set "JUST_SERVE=0"
set "KEEP_PROFILE=0"

:parse_args
if "%~1"=="" goto args_done
set "ARG=%~1"
if /I "!ARG:~0,7!"=="--port=" set "PORT=!ARG:~7!" & shift & goto parse_args
if /I "!ARG!"=="--port" set "PORT=%~2" & shift & shift & goto parse_args
if /I "!ARG:~0,11!"=="--cdp-port=" set "CDP_PORT=!ARG:~11!" & shift & goto parse_args
if /I "!ARG:~0,10!"=="--browser=" set "BROWSER=!ARG:~10!" & shift & goto parse_args
if /I "!ARG!"=="--skip-prepare" set "SKIP_PREPARE=1" & shift & goto parse_args
if /I "!ARG!"=="--just-serve" set "JUST_SERVE=1" & shift & goto parse_args
if /I "!ARG!"=="--keep-profile" set "KEEP_PROFILE=1" & shift & goto parse_args
if /I "!ARG!"=="-h" goto print_help
if /I "!ARG!"=="--help" goto print_help
if /I "!ARG!"=="/?" goto print_help
echo Unknown argument: !ARG! 1>&2
exit /b 2

:print_help
echo Usage:
echo   serve-smokes.cmd                  Serve + chrome + watcher
echo   serve-smokes.cmd --just-serve     Serve only; no chrome / no watcher
echo   serve-smokes.cmd [--port=8080] [--skip-prepare] [--cdp-port=9222] [--browser=chrome^|edge] [--keep-profile]
exit /b 0

:args_done

set "SCRIPT_DIR=%~dp0"
pushd "%SCRIPT_DIR%..\..\..\..\.." >nul
set "REPO_ROOT=%CD%"
popd >nul
set "ARTIFACT_DIR=%REPO_ROOT%\artifacts\wasm-dbi-dac-browser-smoke"

cd /d "%SCRIPT_DIR%"

if "%SKIP_PREPARE%"=="0" (
    echo ==^> prepare.mjs ^(use --skip-prepare to skip^)
    node prepare.mjs
    if errorlevel 1 exit /b %ERRORLEVEL%
)

if not exist "%ARTIFACT_DIR%" (
    echo Error: %ARTIFACT_DIR% does not exist. Run without --skip-prepare. 1>&2
    exit /b 1
)

if "%JUST_SERVE%"=="1" (
    echo ==^> --just-serve: dotnet serve only ^(no chrome / no watcher^)
    echo ==^> Open in any browser:
    echo        http://localhost:%PORT%/index.html
    echo.
    dotnet serve -d "%ARTIFACT_DIR%" -p %PORT% -o:/index.html
    exit /b %ERRORLEVEL%
)

rem Default: serve + chrome + watcher
set "BROWSER_BIN="
if /I "%BROWSER%"=="" goto resolve_auto
if /I "%BROWSER%"=="chrome" goto resolve_chrome
if /I "%BROWSER%"=="edge" goto resolve_edge
set "BROWSER_BIN=%BROWSER%"
goto resolve_done
:resolve_chrome
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set "BROWSER_BIN=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set "BROWSER_BIN=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
goto resolve_done
:resolve_edge
if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" set "BROWSER_BIN=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" set "BROWSER_BIN=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
goto resolve_done
:resolve_auto
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set "BROWSER_BIN=%ProgramFiles%\Google\Chrome\Application\chrome.exe" & goto resolve_done
if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set "BROWSER_BIN=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" & goto resolve_done
if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" set "BROWSER_BIN=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" & goto resolve_done
if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" set "BROWSER_BIN=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" & goto resolve_done
:resolve_done
if "%BROWSER_BIN%"=="" (
    echo Error: no Chrome/Edge binary found. Use --browser=^<path^>. 1>&2
    exit /b 1
)

set "USER_DATA_DIR=%TEMP%\wasm-dbi-dac-demo-%RANDOM%-%RANDOM%"
mkdir "%USER_DATA_DIR%"

rem dotnet serve
echo ==^> dotnet serve on port %PORT%
start "wasm-dbi-dac dotnet serve" /min cmd /c "dotnet serve -d ""%ARTIFACT_DIR%"" -p %PORT% > %TEMP%\wasm-dbi-dac-serve.log 2>&1"
for /L %%i in (1,1,20) do (
    curl -fsS http://localhost:%PORT%/ >nul 2>&1 && goto serve_ok
    timeout /t 1 /nobreak >nul
)
echo Error: dotnet serve did not come up on port %PORT% 1>&2
exit /b 1
:serve_ok

rem launch chrome on index.html with the CDP port open
set "INDEX_URL=http://localhost:%PORT%/index.html"
echo ==^> launching browser: %BROWSER_BIN%
echo ==^>   --remote-debugging-port=%CDP_PORT%
echo ==^>   --user-data-dir=%USER_DATA_DIR%
echo ==^>   URL: %INDEX_URL%
start "" "%BROWSER_BIN%" --remote-debugging-port=%CDP_PORT% --user-data-dir="%USER_DATA_DIR%" --no-first-run --no-default-browser-check --new-window "%INDEX_URL%"

echo ==^> waiting for CDP endpoint http://localhost:%CDP_PORT%/json/version ...
for /L %%i in (1,1,30) do (
    curl -fsS http://localhost:%CDP_PORT%/json/version >nul 2>&1 && goto cdp_ok
    timeout /t 1 /nobreak >nul
)
echo Error: CDP endpoint did not come up on port %CDP_PORT% 1>&2
exit /b 1
:cdp_ok
echo ==^> CDP endpoint is live

echo ==^> starting cdp-driver.mjs --watch
echo ==^> open the smoke index in the browser window that just opened
echo ==^> and click 'hello-async-break' to trigger the IDE-driven demo
echo ==^> ^(Ctrl-C in this terminal to tear down^)
echo.
node cdp-driver.mjs --port=%CDP_PORT% --watch

if "%KEEP_PROFILE%"=="0" if exist "%USER_DATA_DIR%" rmdir /s /q "%USER_DATA_DIR%"

exit /b 0
