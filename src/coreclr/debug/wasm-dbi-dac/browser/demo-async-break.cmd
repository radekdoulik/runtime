@echo off
rem Licensed to the .NET Foundation under one or more agreements.
rem The .NET Foundation licenses this file to you under the MIT license.
rem
rem demo-async-break.cmd — single-step IDE-driven async-break demo.
rem
rem Launches in one go:
rem   1. dotnet serve (background)
rem   2. Chrome/Edge with --remote-debugging-port=9222 + isolated
rem      --user-data-dir, navigating to the demo page (background)
rem   3. cdp-driver.mjs — Node script that connects to port 9222 and
rem      runs the 8-step IDE/mscordbi orchestration over CDP
rem
rem Same pattern as Mono's BrowserDebugProxy bundled into one command.
rem
rem Usage:
rem   demo-async-break.cmd [--skip-prepare] [--port=8080] [--cdp-port=9222] [--browser=chrome|edge]

setlocal enabledelayedexpansion

set "PORT=8080"
set "CDP_PORT=9222"
set "BROWSER="
set "SKIP_PREPARE=0"
set "KEEP_PROFILE=0"

:parse_args
if "%~1"=="" goto args_done
set "ARG=%~1"
if /I "!ARG:~0,7!"=="--port=" set "PORT=!ARG:~7!" & shift & goto parse_args
if /I "!ARG:~0,11!"=="--cdp-port=" set "CDP_PORT=!ARG:~11!" & shift & goto parse_args
if /I "!ARG:~0,10!"=="--browser=" set "BROWSER=!ARG:~10!" & shift & goto parse_args
if /I "!ARG!"=="--skip-prepare" set "SKIP_PREPARE=1" & shift & goto parse_args
if /I "!ARG!"=="--keep-profile" set "KEEP_PROFILE=1" & shift & goto parse_args
if /I "!ARG!"=="-h" goto help
if /I "!ARG!"=="--help" goto help
echo Unknown argument: !ARG! 1>&2
exit /b 2
:args_done

cd /d "%~dp0"

if "%SKIP_PREPARE%"=="0" (
    echo ==^> prepare.mjs ^(use --skip-prepare to skip^)
    call node prepare.mjs || exit /b 1
)

set "ARTIFACT_DIR=%~dp0..\..\..\..\..\artifacts\wasm-dbi-dac-browser-smoke"
if not exist "%ARTIFACT_DIR%" (
    echo Error: %ARTIFACT_DIR% does not exist. Run without --skip-prepare. 1>&2
    exit /b 1
)

rem Resolve browser binary
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

rem Temp user-data-dir
set "USER_DATA_DIR=%TEMP%\wasm-dbi-dac-demo-%RANDOM%-%RANDOM%"
mkdir "%USER_DATA_DIR%"

rem Step 1: dotnet serve (skip if one is already running on PORT)
set "SERVE_OWNED=1"
curl -fsS http://localhost:%PORT%/ >nul 2>&1
if not errorlevel 1 (
    echo ==^> reusing existing http server on port %PORT%
    set "SERVE_OWNED=0"
    goto serve_ok
)
echo ==^> dotnet serve on port %PORT%
start "wasm-dbi-dac dotnet serve" /min cmd /c "dotnet serve -d ""%ARTIFACT_DIR%"" -p %PORT% > %TEMP%\wasm-dbi-dac-demo-serve.log 2>&1"

rem Wait for serve
for /L %%i in (1,1,20) do (
    curl -fsS http://localhost:%PORT%/ >nul 2>&1 && goto serve_ok
    timeout /t 1 /nobreak >nul
)
echo Error: dotnet serve did not come up on port %PORT% 1>&2
exit /b 1
:serve_ok

rem Step 2: launch browser
set "DEMO_URL=http://localhost:%PORT%/hello-async-break.html?wait-for-external-dbi=1"
echo ==^> launching browser: %BROWSER_BIN%
echo ==^>   --remote-debugging-port=%CDP_PORT%
echo ==^>   --user-data-dir=%USER_DATA_DIR%
echo ==^>   URL: %DEMO_URL%

start "" "%BROWSER_BIN%" --remote-debugging-port=%CDP_PORT% --user-data-dir="%USER_DATA_DIR%" --no-first-run --no-default-browser-check --new-window "%DEMO_URL%"

rem Wait for CDP endpoint
echo ==^> waiting for CDP endpoint http://localhost:%CDP_PORT%/json/version ...
for /L %%i in (1,1,30) do (
    curl -fsS http://localhost:%CDP_PORT%/json/version >nul 2>&1 && goto cdp_ok
    timeout /t 1 /nobreak >nul
)
echo Error: CDP endpoint did not come up on port %CDP_PORT% 1>&2
exit /b 1
:cdp_ok
echo ==^> CDP endpoint is live

rem Step 3: run the CDP driver
echo ==^> running cdp-driver.mjs ^(the IDE/mscordbi role^)
echo.
node cdp-driver.mjs --port=%CDP_PORT% --target-url-substring=hello-async-break.html
set "DRIVER_RC=%ERRORLEVEL%"

if "%DRIVER_RC%"=="0" (
    echo.
    echo ==^> demo complete ^(PASS^). Browser window left open so you can inspect.
    echo ==^> Close the browser window or press Enter to tear down.
    pause >nul
) else (
    echo ==^> demo FAILED ^(driver exit code %DRIVER_RC%^) 1>&2
)

if "%KEEP_PROFILE%"=="0" if exist "%USER_DATA_DIR%" rmdir /s /q "%USER_DATA_DIR%"

exit /b %DRIVER_RC%

:help
echo demo-async-break.cmd [--skip-prepare] [--port=8080] [--cdp-port=9222] [--browser=chrome^|edge]
exit /b 0
