@echo off
rem Licensed to the .NET Foundation under one or more agreements.
rem The .NET Foundation licenses this file to you under the MIT license.
rem
rem serve-smokes.cmd — prepare + serve the browser smoke harness, and
rem by default launch the single-command IDE-driven async-break demo
rem (chrome --remote-debugging-port=9222 + cdp-driver.mjs).
rem
rem Usage:
rem   serve-smokes.cmd                  Serve + run the async demo
rem   serve-smokes.cmd --just-serve     Only serve; don't launch chrome / cdp-driver
rem   serve-smokes.cmd [--port=8080] [--skip-prepare] [--cdp-port=9222] [--browser=chrome^|edge]

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
echo   serve-smokes.cmd                  Serve + run the async demo
echo   serve-smokes.cmd --just-serve     Only serve; don't launch chrome
echo   serve-smokes.cmd [--port=8080] [--skip-prepare] [--cdp-port=9222] [--browser=chrome^|edge]
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
    echo ==^> dotnet serve on port %PORT% ^(just-serve mode; no demo^)
    echo ==^> Open in Chrome ^(the async demo will NOT run on its own —
    echo ==^>   for the IDE-driven demo re-run without --just-serve, or
    echo ==^>   run demo-async-break.cmd, or load extension\^):
    echo        http://localhost:%PORT%/hello-breakpoint.html
    echo        http://localhost:%PORT%/hello-cdp-pause.html
    echo        http://localhost:%PORT%/hello-async-break.html
    echo.
    dotnet serve -d "%ARTIFACT_DIR%" -p %PORT% -o:/index.html
    exit /b %ERRORLEVEL%
)

rem Default mode: run the full IDE-driven async-break demo.
echo ==^> running full IDE-driven async-break demo ^(use --just-serve to skip^)
echo.
set "DEMO_ARGS=--skip-prepare --port=%PORT% --cdp-port=%CDP_PORT%"
if not "%BROWSER%"=="" set "DEMO_ARGS=%DEMO_ARGS% --browser=%BROWSER%"
if "%KEEP_PROFILE%"=="1" set "DEMO_ARGS=%DEMO_ARGS% --keep-profile"
call demo-async-break.cmd %DEMO_ARGS%
exit /b %ERRORLEVEL%
