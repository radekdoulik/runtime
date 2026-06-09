@echo off
rem Licensed to the .NET Foundation under one or more agreements.
rem The .NET Foundation licenses this file to you under the MIT license.
rem
rem run-smokes.cmd — run browser smokes via Playwright (headless Chromium).
rem
rem Usage:
rem   run-smokes.cmd [--headed] [--skip-prepare] [--smoke=<name>]
rem
rem Examples:
rem   run-smokes.cmd                            (all browser smokes, headless)
rem   run-smokes.cmd --headed                   (all smokes with visible Chromium)
rem   run-smokes.cmd --smoke=hello-breakpoint   (one smoke only)

setlocal enabledelayedexpansion

set "HEADED=0"
set "SKIP_PREPARE=0"
set "SMOKE="

:parse_args
if "%~1"=="" goto args_done
set "ARG=%~1"
if /I "!ARG!"=="--headed" (
    set "HEADED=1"
    shift
    goto parse_args
)
if /I "!ARG!"=="--skip-prepare" (
    set "SKIP_PREPARE=1"
    shift
    goto parse_args
)
if /I "!ARG:~0,8!"=="--smoke=" (
    set "SMOKE=!ARG:~8!"
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
echo   run-smokes.cmd [--headed] [--skip-prepare] [--smoke=^<name^>]
echo.
echo Examples:
echo   run-smokes.cmd                            ^(all browser smokes, headless^)
echo   run-smokes.cmd --headed                   ^(all smokes with visible Chromium^)
echo   run-smokes.cmd --smoke=hello-breakpoint   ^(one smoke only^)
exit /b 0

:args_done

set "SCRIPT_DIR=%~dp0"
cd /d "%SCRIPT_DIR%"

if "%SKIP_PREPARE%"=="0" (
    echo ==^> prepare.mjs ^(use --skip-prepare to skip^)
    node prepare.mjs
    if errorlevel 1 exit /b %ERRORLEVEL%
)

if not exist "node_modules\@playwright" (
    echo ==^> Installing @playwright/test ^(one-time^)
    call npm install --no-save --no-package-lock @playwright/test
    if errorlevel 1 exit /b %ERRORLEVEL%
    call npx playwright install chromium
    if errorlevel 1 exit /b %ERRORLEVEL%
)

set "PLAYWRIGHT_ARGS="
if "%HEADED%"=="1" set "PLAYWRIGHT_ARGS=!PLAYWRIGHT_ARGS! --headed"
if not "%SMOKE%"=="" set "PLAYWRIGHT_ARGS=!PLAYWRIGHT_ARGS! tests/%SMOKE%.spec.mjs"

echo ==^> npx playwright test%PLAYWRIGHT_ARGS%
call npx playwright test%PLAYWRIGHT_ARGS%
