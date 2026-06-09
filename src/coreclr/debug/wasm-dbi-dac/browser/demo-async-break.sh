#!/usr/bin/env bash
# Licensed to the .NET Foundation under one or more agreements.
# The .NET Foundation licenses this file to you under the MIT license.
#
# demo-async-break.sh — single-step IDE-driven async-break demo.
#
# Launches in one go:
#   1. dotnet serve (background)
#   2. Chrome/Edge/Chromium with --remote-debugging-port=9222 +
#      isolated --user-data-dir, navigating to the demo page (background)
#   3. cdp-driver.mjs — Node script that connects to port 9222 and
#      runs the 8-step IDE/mscordbi orchestration over CDP
#
# Same pattern as Mono's BrowserDebugProxy (chrome --remote-debugging
# + external proxy process), bundled into one command.
#
# Usage:
#   ./demo-async-break.sh [--skip-prepare] [--port=8080] [--cdp-port=9222] [--browser=chrome|edge|chromium]

set -euo pipefail

PORT=8080
CDP_PORT=9222
BROWSER=""
SKIP_PREPARE=0
KEEP_PROFILE=0

for arg in "$@"; do
    case "$arg" in
        --skip-prepare) SKIP_PREPARE=1 ;;
        --keep-profile) KEEP_PROFILE=1 ;;
        --port=*) PORT="${arg#--port=}" ;;
        --cdp-port=*) CDP_PORT="${arg#--cdp-port=}" ;;
        --browser=*) BROWSER="${arg#--browser=}" ;;
        -h|--help)
            sed -n '5,17p' "$0" | sed 's/^# \{0,1\}//'
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

# Detect whether a serve is already running on this port; reuse it if so
# so the user can leave `serve-smokes.sh` running in another terminal.
SERVE_OWNED=0
if curl -fsS "http://localhost:${PORT}/" >/dev/null 2>&1; then
    echo "==> reusing existing http server on port ${PORT}"
else
    SERVE_OWNED=1
fi

# ---- Resolve browser binary ----
resolve_browser() {
    local want="$1"
    local candidates=()
    case "${want:-auto}" in
        chrome|google-chrome)
            candidates=(
                "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
                "google-chrome"
                "google-chrome-stable"
                "chrome"
            )
            ;;
        edge|msedge)
            candidates=(
                "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
                "msedge"
                "microsoft-edge"
            )
            ;;
        chromium)
            candidates=(
                "/Applications/Chromium.app/Contents/MacOS/Chromium"
                "chromium"
                "chromium-browser"
            )
            ;;
        ""|auto)
            candidates=(
                "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
                "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
                "/Applications/Chromium.app/Contents/MacOS/Chromium"
                "google-chrome"
                "google-chrome-stable"
                "chrome"
                "msedge"
                "microsoft-edge"
                "chromium"
                "chromium-browser"
            )
            ;;
        *) echo "$want"; return ;;
    esac
    for c in "${candidates[@]}"; do
        if [ -x "$c" ]; then
            echo "$c"
            return
        fi
        if command -v "$c" >/dev/null 2>&1; then
            command -v "$c"
            return
        fi
    done
    echo ""
}

BROWSER_BIN="$(resolve_browser "${BROWSER}")"
if [ -z "${BROWSER_BIN}" ]; then
    echo "Error: no Chrome/Edge/Chromium binary found. Use --browser=<path-or-name>." >&2
    exit 1
fi

# ---- Temp user-data-dir so we don't disturb the user's real profile ----
USER_DATA_DIR="$(mktemp -d -t wasm-dbi-dac-demo-XXXXXX)"

cleanup() {
    local rc=$?
    set +e
    if [ -n "${BROWSER_PID:-}" ] && kill -0 "$BROWSER_PID" 2>/dev/null; then
        echo "==> stopping browser (PID ${BROWSER_PID})"
        kill "$BROWSER_PID" 2>/dev/null
        sleep 0.5
        kill -9 "$BROWSER_PID" 2>/dev/null
    fi
    if [ "${SERVE_OWNED}" -eq 1 ] && [ -n "${SERVE_PID:-}" ] && kill -0 "$SERVE_PID" 2>/dev/null; then
        echo "==> stopping dotnet serve (PID ${SERVE_PID})"
        kill "$SERVE_PID" 2>/dev/null
        sleep 0.5
        kill -9 "$SERVE_PID" 2>/dev/null
    fi
    if [ "${KEEP_PROFILE}" -eq 0 ] && [ -d "${USER_DATA_DIR}" ]; then
        rm -rf "${USER_DATA_DIR}"
    else
        echo "==> user-data-dir kept at: ${USER_DATA_DIR}"
    fi
    exit $rc
}
trap cleanup EXIT INT TERM

# ---- Step 1: dotnet serve (skipped if we're reusing an existing one) ----
if [ "${SERVE_OWNED}" -eq 1 ]; then
    echo "==> dotnet serve on port ${PORT}"
    dotnet serve -d "${ARTIFACT_DIR}" -p "${PORT}" >/tmp/wasm-dbi-dac-demo-serve.log 2>&1 &
    SERVE_PID=$!
    for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
        if curl -fsS "http://localhost:${PORT}/" >/dev/null 2>&1; then break; fi
        sleep 0.3
    done
    if ! curl -fsS "http://localhost:${PORT}/" >/dev/null 2>&1; then
        echo "Error: dotnet serve did not come up on port ${PORT}" >&2
        cat /tmp/wasm-dbi-dac-demo-serve.log >&2 || true
        exit 1
    fi
fi

# ---- Step 2: launch browser with remote-debugging-port ----
DEMO_URL="http://localhost:${PORT}/hello-async-break.html?wait-for-external-dbi=1"
echo "==> launching browser: ${BROWSER_BIN}"
echo "==>   --remote-debugging-port=${CDP_PORT}"
echo "==>   --user-data-dir=${USER_DATA_DIR}"
echo "==>   URL: ${DEMO_URL}"

"${BROWSER_BIN}" \
    --remote-debugging-port="${CDP_PORT}" \
    --user-data-dir="${USER_DATA_DIR}" \
    --no-first-run \
    --no-default-browser-check \
    --new-window \
    "${DEMO_URL}" \
    >/tmp/wasm-dbi-dac-demo-browser.log 2>&1 &
BROWSER_PID=$!

# Wait for CDP endpoint to be live
echo "==> waiting for CDP endpoint http://localhost:${CDP_PORT}/json/version ..."
for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30; do
    if curl -fsS "http://localhost:${CDP_PORT}/json/version" >/dev/null 2>&1; then break; fi
    sleep 0.3
done
if ! curl -fsS "http://localhost:${CDP_PORT}/json/version" >/dev/null 2>&1; then
    echo "Error: CDP endpoint did not come up on port ${CDP_PORT}" >&2
    cat /tmp/wasm-dbi-dac-demo-browser.log >&2 || true
    exit 1
fi
echo "==> CDP endpoint is live"

# ---- Step 3: run the CDP driver ----
echo "==> running cdp-driver.mjs (the IDE/mscordbi role)"
echo
node cdp-driver.mjs --port="${CDP_PORT}" --target-url-substring=hello-async-break.html
DRIVER_RC=$?

if [ "${DRIVER_RC}" -eq 0 ]; then
    echo
    echo "==> demo complete (PASS). Browser window left open so you can inspect the rendered pause panel."
    echo "==> Close the browser window manually when done (or press Ctrl-C in this terminal)."
    if [ -t 0 ]; then
        # Interactive shell: block until user Ctrl-C or browser exit.
        wait "${BROWSER_PID}" 2>/dev/null || true
    fi
else
    echo "==> demo FAILED (driver exit code ${DRIVER_RC})" >&2
    exit "${DRIVER_RC}"
fi
