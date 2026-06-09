#!/usr/bin/env bash
# Licensed to the .NET Foundation under one or more agreements.
# The .NET Foundation licenses this file to you under the MIT license.
#
# serve-smokes.sh — prepare + serve browser smoke harness for manual use.
#
# Usage:
#   ./serve-smokes.sh [--port=8080] [--skip-prepare]
#
# After it starts, open in Chrome:
#   http://localhost:<port>/hello-breakpoint.html
#   http://localhost:<port>/hello-cdp-pause.html

set -euo pipefail

PORT=8080
SKIP_PREPARE=0

for arg in "$@"; do
    case "$arg" in
        --port=*) PORT="${arg#--port=}" ;;
        --port)
            shift
            PORT="$1"
            ;;
        --skip-prepare) SKIP_PREPARE=1 ;;
        -h|--help)
            sed -n '5,12p' "$0" | sed 's/^# \{0,1\}//'
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

echo "==> dotnet serve on port ${PORT}"
echo "==> Open in Chrome:"
echo "       http://localhost:${PORT}/hello-breakpoint.html"
echo "       http://localhost:${PORT}/hello-cdp-pause.html"
echo "       http://localhost:${PORT}/hello-async-break.html"
echo
echo "==> For the single-step IDE/DBI demo (chrome --remote-debugging-port=9222"
echo "==>   + cdp-driver.mjs orchestrator), run in another terminal:"
echo "==>     ./demo-async-break.sh"
echo "==> (it auto-detects this serve and reuses it)."
echo
echo "==> The Chrome extension at extension/ provides the same flow"
echo "==> using chrome.debugger API; see extension/README.md."
echo

exec dotnet serve -d "${ARTIFACT_DIR}" -p "${PORT}" -o:/index.html
