#!/usr/bin/env bash
# Licensed to the .NET Foundation under one or more agreements.
# The .NET Foundation licenses this file to you under the MIT license.
#
# serve-smokes.sh — prepare + serve the browser smoke harness, and
# by default launch the single-command IDE-driven async-break demo
# (chrome --remote-debugging-port=9222 + cdp-driver.mjs).
#
# Usage:
#   ./serve-smokes.sh                  # serve + run the async-break demo end-to-end
#   ./serve-smokes.sh --just-serve     # only serve the smokes; don't launch chrome / cdp-driver
#   ./serve-smokes.sh [--port=8080] [--skip-prepare] [--cdp-port=9222] [--browser=chrome|edge|chromium]

set -euo pipefail

PORT=8080
CDP_PORT=9222
BROWSER=""
SKIP_PREPARE=0
JUST_SERVE=0
KEEP_PROFILE=0

for arg in "$@"; do
    case "$arg" in
        --port=*) PORT="${arg#--port=}" ;;
        --port)
            shift
            PORT="$1"
            ;;
        --cdp-port=*) CDP_PORT="${arg#--cdp-port=}" ;;
        --browser=*) BROWSER="${arg#--browser=}" ;;
        --skip-prepare) SKIP_PREPARE=1 ;;
        --just-serve) JUST_SERVE=1 ;;
        --keep-profile) KEEP_PROFILE=1 ;;
        -h|--help)
            sed -n '5,14p' "$0" | sed 's/^# \{0,1\}//'
            exit 0
            ;;
        *)
            echo "Unknown argument: $arg" >&2
            exit 2
            ;;
    esac
done

SCRIPT_DIR="$( cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"
REPO_ROOT="$( cd -- "${SCRIPT_DIR}/../../../../.." &> /dev/null && pwd )"
ARTIFACT_DIR="${REPO_ROOT}/artifacts/wasm-dbi-dac-browser-smoke"

cd "${SCRIPT_DIR}"

if [ "${SKIP_PREPARE}" -eq 0 ]; then
    echo "==> prepare.mjs (use --skip-prepare to skip)"
    node prepare.mjs
fi

if [ ! -d "${ARTIFACT_DIR}" ]; then
    echo "Error: ${ARTIFACT_DIR} does not exist. Run without --skip-prepare." >&2
    exit 1
fi

if [ "${JUST_SERVE}" -eq 1 ]; then
    echo "==> dotnet serve on port ${PORT} (just-serve mode; no demo)"
    echo "==> Open in Chrome (the async demo will NOT run on its own —"
    echo "==>   for the IDE-driven demo re-run without --just-serve, or"
    echo "==>   run ./demo-async-break.sh, or load extension/):"
    echo "       http://localhost:${PORT}/hello-breakpoint.html"
    echo "       http://localhost:${PORT}/hello-cdp-pause.html"
    echo "       http://localhost:${PORT}/hello-async-break.html"
    echo
    exec dotnet serve -d "${ARTIFACT_DIR}" -p "${PORT}" -o:/index.html
fi

# Default mode: serve + run the IDE-driven async-break demo end-to-end.
# This is the same flow demo-async-break.sh implements.
echo "==> running full IDE-driven async-break demo (use --just-serve to skip)"
echo
exec ./demo-async-break.sh \
    --skip-prepare \
    --port="${PORT}" \
    --cdp-port="${CDP_PORT}" \
    $( [ -n "${BROWSER}" ] && echo "--browser=${BROWSER}" ) \
    $( [ "${KEEP_PROFILE}" -eq 1 ] && echo "--keep-profile" )
