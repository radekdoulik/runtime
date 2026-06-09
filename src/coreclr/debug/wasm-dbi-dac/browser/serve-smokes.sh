#!/usr/bin/env bash
# Licensed to the .NET Foundation under one or more agreements.
# The .NET Foundation licenses this file to you under the MIT license.
#
# serve-smokes.sh — prepare + serve the browser smoke harness for
# manual exploration. Open index.html to pick a smoke (hello-breakpoint,
# hello-cdp-pause, hello-async-break).
#
# Usage:
#   ./serve-smokes.sh                  # serve all smokes; open index.html in default browser
#   ./serve-smokes.sh --async-demo     # also run the full IDE-driven async-break demo (delegates to demo-async-break.sh)
#   ./serve-smokes.sh [--port=8080] [--skip-prepare] [--no-open]

set -euo pipefail

PORT=8080
SKIP_PREPARE=0
ASYNC_DEMO=0
NO_OPEN=0

for arg in "$@"; do
    case "$arg" in
        --port=*) PORT="${arg#--port=}" ;;
        --port)
            shift
            PORT="$1"
            ;;
        --skip-prepare) SKIP_PREPARE=1 ;;
        --async-demo) ASYNC_DEMO=1 ;;
        --no-open) NO_OPEN=1 ;;
        -h|--help)
            sed -n '5,13p' "$0" | sed 's/^# \{0,1\}//'
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

# --async-demo: delegate to demo-async-break.sh which handles the full
# IDE-driven async-break CDP demo (chrome --remote-debugging-port=9222
# + cdp-driver.mjs). It will detect this serve and reuse it if we are
# already running one, but in this --async-demo flow we hand control to
# it entirely (it starts dotnet serve itself).
if [ "${ASYNC_DEMO}" -eq 1 ]; then
    echo "==> --async-demo: handing control to demo-async-break.sh"
    echo
    exec ./demo-async-break.sh \
        --skip-prepare \
        --port="${PORT}"
fi

OPEN_ARG=""
if [ "${NO_OPEN}" -eq 0 ]; then
    OPEN_ARG="-o:/index.html"
fi

echo "==> dotnet serve on port ${PORT}"
echo "==> Open in Chrome (index.html will be opened automatically):"
echo "       http://localhost:${PORT}/hello-breakpoint.html"
echo "       http://localhost:${PORT}/hello-cdp-pause.html"
echo "       http://localhost:${PORT}/hello-async-break.html"
echo
echo "==> NOTE: hello-async-break.html is a passive runtime host —"
echo "==>       opening it alone runs the busy loop without any pause"
echo "==>       or DAC inspection. To see the full IDE-driven async-break"
echo "==>       + locals demo run one of:"
echo "==>          ./serve-smokes.sh --async-demo   (single command, restart this script)"
echo "==>          ./demo-async-break.sh            (in another terminal; reuses this serve)"
echo "==>          load extension/ as an unpacked Chrome extension; see extension/README.md"
echo
exec dotnet serve -d "${ARTIFACT_DIR}" -p "${PORT}" ${OPEN_ARG}
