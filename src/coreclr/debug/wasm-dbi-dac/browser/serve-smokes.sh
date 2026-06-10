#!/usr/bin/env bash
# Licensed to the .NET Foundation under one or more agreements.
# The .NET Foundation licenses this file to you under the MIT license.
#
# serve-smokes.sh — prepare + serve the browser smoke harness AND
# launch the IDE-driven async-break demo (chrome --remote-debugging
# + cdp-driver.mjs orchestrator). All other smokes (hello-breakpoint,
# hello-cdp-pause) are still available via the same dotnet serve;
# open index.html in the browser to pick one.
#
# Usage:
#   ./serve-smokes.sh                  # serve + run the async demo
#   ./serve-smokes.sh --just-serve     # serve only; no async demo / no chrome launch
#   ./serve-smokes.sh [--port=8080] [--skip-prepare] [--cdp-port=9222] [--browser=chrome|edge|chromium] [--keep-profile]

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

# --just-serve: skip the async demo orchestrator, just serve the smokes
# (the original behaviour). Useful when the user only wants to poke at
# hello-breakpoint or hello-cdp-pause manually.
if [ "${JUST_SERVE}" -eq 1 ]; then
    echo "==> --just-serve: dotnet serve only (no async-demo orchestrator)"
    echo "==> Open in Chrome:"
    echo "       http://localhost:${PORT}/index.html"
    echo "       http://localhost:${PORT}/hello-breakpoint.html"
    echo "       http://localhost:${PORT}/hello-cdp-pause.html"
    echo "       http://localhost:${PORT}/hello-async-break.html"
    echo
    exec dotnet serve -d "${ARTIFACT_DIR}" -p "${PORT}" -o:/index.html
fi

# Default: serve + run the async demo end-to-end. demo-async-break.sh
# will detect that dotnet serve is already running on this port (the
# only thing we'd have done first anyway) — but to keep ordering simple
# we delegate the entire flow to it (it starts dotnet serve itself if
# none is running, and reuses one if there is).
echo "==> serving + running IDE-driven async-break demo (use --just-serve to skip the demo)"
echo
exec ./demo-async-break.sh \
    --skip-prepare \
    --port="${PORT}" \
    --cdp-port="${CDP_PORT}" \
    $( [ -n "${BROWSER}" ] && echo "--browser=${BROWSER}" ) \
    $( [ "${KEEP_PROFILE}" -eq 1 ] && echo "--keep-profile" )
