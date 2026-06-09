@echo off
rem Licensed to the .NET Foundation under one or more agreements.
rem The .NET Foundation licenses this file to you under the MIT license.
rem
rem serve-smokes.cmd — prepare + serve browser smoke harness for manual use.
rem
rem Usage:
rem   serve-smokes.cmd [--port=8080] [--skip-prepare]
rem
rem After it starts, open in Chrome:
rem   http://localhost:<port>/hello-breakpoint.html
rem   http://localhost:<port>/hello-async-break.html

setlocal enabledelayedexpansion

set "PORT=8080"
set "SKIP_PREPARE=0"

:parse_args
if "%~1"=="" goto args_done
set "ARG=%~1"
if /I "!ARG:~0,7!"=="--port=" (
    set "PORT=!ARG:~7!"
    shift
    goto parse_args
)
if /I "!ARG!"=="--port" (
    set "PORT=%~2"
    shift
    shift
    goto parse_args
)
if /I "!ARG!"=="--skip-prepare" (
    set "SKIP_PREPARE=1"
    shift
    goto parse_args
)
if /I "!ARG!"=="-h" goto print_help
if /I "!ARG!"=="--help" goto print_help
if /I "!ARG!"=="/?" goto print_help
echo Unknown argument: !ARG! 1>&2
exit /b 2

:print_help
echo Usage:
echo   serve-smokes.cmd [--port=8080] [--skip-prepare]
echo.
echo After it starts, open in Chrome:
echo   http://localhost:^<port^>/hello-breakpoint.html
echo   http://localhost:^<port^>/hello-async-break.html
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

echo ==^> dotnet serve on port %PORT%
echo ==^> Open in Chrome:
echo        http://localhost:%PORT%/hello-breakpoint.html
echo        http://localhost:%PORT%/hello-async-break.html
echo.

dotnet serve -d "%ARTIFACT_DIR%" -p %PORT%
