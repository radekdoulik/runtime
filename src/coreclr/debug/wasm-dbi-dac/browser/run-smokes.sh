#!/usr/bin/env bash
# Licensed to the .NET Foundation under one or more agreements.
# The .NET Foundation licenses this file to you under the MIT license.
#
# run-smokes.sh — run browser smokes via Playwright (headless Chromium).
#
# Usage:
#   ./run-smokes.sh [--headed] [--skip-prepare] [--smoke=<name>]
#
# Examples:
#   ./run-smokes.sh                           # all browser smokes, headless
#   ./run-smokes.sh --headed                  # all smokes with visible Chromium
#   ./run-smokes.sh --smoke=hello-breakpoint  # one smoke only

set -euo pipefail

HEADED=0
SKIP_PREPARE=0
SMOKE=""

for arg in "$@"; do
    case "$arg" in
        --headed) HEADED=1 ;;
        --skip-prepare) SKIP_PREPARE=1 ;;
        --smoke=*) SMOKE="${arg#--smoke=}" ;;
        -h|--help)
            sed -n '5,15p' "$0" | sed 's/^# \{0,1\}//'
            exit 0
            ;;
        *)
            echo "Unknown argument: $arg" >&2
            exit 2
            ;;
    esac
done

SCRIPT_DIR="$( cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"
cd "${SCRIPT_DIR}"

if [ "${SKIP_PREPARE}" -eq 0 ]; then
    echo "==> prepare.mjs (use --skip-prepare to skip)"
    node prepare.mjs
fi

if [ ! -d "node_modules/@playwright" ]; then
    echo "==> Installing @playwright/test (one-time)"
    npm install --no-save --no-package-lock @playwright/test
    npx playwright install chromium
fi

PLAYWRIGHT_ARGS=()
[ "${HEADED}" -eq 1 ] && PLAYWRIGHT_ARGS+=("--headed")
[ -n "${SMOKE}" ] && PLAYWRIGHT_ARGS+=("tests/${SMOKE}.spec.mjs")

if [ ${#PLAYWRIGHT_ARGS[@]} -eq 0 ]; then
    echo "==> npx playwright test"
    exec npx playwright test
else
    echo "==> npx playwright test ${PLAYWRIGHT_ARGS[*]}"
    exec npx playwright test "${PLAYWRIGHT_ARGS[@]}"
fi
