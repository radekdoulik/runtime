@echo off
rem Licensed to the .NET Foundation under one or more agreements.
rem The .NET Foundation licenses this file to you under the MIT license.
rem
rem serve-smokes.cmd — prepare + serve the browser smoke harness for
rem manual exploration. Open index.html to pick a smoke.
rem
rem Usage:
rem   serve-smokes.cmd                  Serve all smokes; open index.html
rem   serve-smokes.cmd --async-demo     Run the IDE-driven async-break demo (delegates to demo-async-break.cmd)
rem   serve-smokes.cmd [--port=8080] [--skip-prepare] [--no-open]

setlocal enabledelayedexpansion

set "PORT=8080"
set "SKIP_PREPARE=0"
set "ASYNC_DEMO=0"
set "NO_OPEN=0"

:parse_args
if "%~1"=="" goto args_done
set "ARG=%~1"
if /I "!ARG:~0,7!"=="--port=" set "PORT=!ARG:~7!" & shift & goto parse_args
if /I "!ARG!"=="--port" set "PORT=%~2" & shift & shift & goto parse_args
if /I "!ARG!"=="--skip-prepare" set "SKIP_PREPARE=1" & shift & goto parse_args
if /I "!ARG!"=="--async-demo" set "ASYNC_DEMO=1" & shift & goto parse_args
if /I "!ARG!"=="--no-open" set "NO_OPEN=1" & shift & goto parse_args
if /I "!ARG!"=="-h" goto print_help
if /I "!ARG!"=="--help" goto print_help
if /I "!ARG!"=="/?" goto print_help
echo Unknown argument: !ARG! 1>&2
exit /b 2

:print_help
echo Usage:
echo   serve-smokes.cmd                  Serve all smokes; open index.html
echo   serve-smokes.cmd --async-demo     Run the IDE-driven async-break demo
echo   serve-smokes.cmd [--port=8080] [--skip-prepare] [--no-open]
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

if "%ASYNC_DEMO%"=="1" (
    echo ==^> --async-demo: handing control to demo-async-break.cmd
    echo.
    call demo-async-break.cmd --skip-prepare --port=%PORT%
    exit /b %ERRORLEVEL%
)

set "OPEN_ARG=-o:/index.html"
if "%NO_OPEN%"=="1" set "OPEN_ARG="

echo ==^> dotnet serve on port %PORT%
echo ==^> Open in Chrome ^(index.html will be opened automatically^):
echo        http://localhost:%PORT%/hello-breakpoint.html
echo        http://localhost:%PORT%/hello-cdp-pause.html
echo        http://localhost:%PORT%/hello-async-break.html
echo.
echo ==^> NOTE: hello-async-break.html is a passive runtime host —
echo ==^>       opening it alone runs the busy loop without any pause
echo ==^>       or DAC inspection. To see the full IDE-driven async-break
echo ==^>       + locals demo run one of:
echo ==^>          serve-smokes.cmd --async-demo   ^(single command, restart this script^)
echo ==^>          demo-async-break.cmd            ^(in another terminal; reuses this serve^)
echo ==^>          load extension\ as an unpacked Chrome extension; see extension\README.md
echo.

dotnet serve -d "%ARTIFACT_DIR%" -p %PORT% %OPEN_ARG%
exit /b %ERRORLEVEL%
