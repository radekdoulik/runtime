#!/usr/bin/env bash
# Licensed to the .NET Foundation under one or more agreements.
# The .NET Foundation licenses this file to you under the MIT license.
#
# serve-smokes.sh — prepare + serve the browser smoke harness, launch
# Chrome with --remote-debugging-port=9222 on the smoke index, and
# start the cdp-driver in watch mode so the async-break demo runs
# automatically when the user clicks the hello-async-break link in
# the index.
#
# Usage:
#   ./serve-smokes.sh                  # serve + chrome + watcher (default)
#   ./serve-smokes.sh --just-serve     # serve only; no chrome launch; no watcher
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

if [ "${JUST_SERVE}" -eq 1 ]; then
    echo "==> --just-serve: dotnet serve only (no chrome launch / no watcher)"
    echo "==> Open in any browser:"
    echo "       http://localhost:${PORT}/index.html"
    echo
    exec dotnet serve -d "${ARTIFACT_DIR}" -p "${PORT}" -o:/index.html
fi

# Default mode: serve + chrome + watcher.
#
# - dotnet serve in background (terminated on script exit)
# - chrome with --remote-debugging-port=$CDP_PORT and an isolated
#   --user-data-dir, opening /index.html (NOT the demo directly)
# - cdp-driver.mjs --watch in the foreground (blocking). It polls
#   chrome's /json endpoint for any tab whose URL contains
#   hello-async-break.html AND ?wait-for-external-dbi=1, then drives
#   the 8-step demo on that tab. The hello-async-break link in
#   index.html includes the query param so a single click triggers
#   the demo.
#
# Ctrl-C tears everything down cleanly via the trap.

# --- resolve browser binary (same logic as demo-async-break.sh) ---
resolve_browser() {
    local want="$1"
    local candidates=()
    case "${want:-auto}" in
        chrome|google-chrome)
            candidates=(
                "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
                "google-chrome" "google-chrome-stable" "chrome"
            )
            ;;
        edge|msedge)
            candidates=(
                "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
                "msedge" "microsoft-edge"
            )
            ;;
        chromium)
            candidates=(
                "/Applications/Chromium.app/Contents/MacOS/Chromium"
                "chromium" "chromium-browser"
            )
            ;;
        ""|auto)
            candidates=(
                "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
                "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
                "/Applications/Chromium.app/Contents/MacOS/Chromium"
                "google-chrome" "google-chrome-stable" "chrome"
                "msedge" "microsoft-edge"
                "chromium" "chromium-browser"
            )
            ;;
        *) echo "$want"; return ;;
    esac
    for c in "${candidates[@]}"; do
        if [ -x "$c" ]; then
            echo "$c"; return
        fi
        if command -v "$c" >/dev/null 2>&1; then
            command -v "$c"; return
        fi
    done
    echo ""
}

BROWSER_BIN="$(resolve_browser "${BROWSER}")"
if [ -z "${BROWSER_BIN}" ]; then
    echo "Error: no Chrome/Edge/Chromium binary found. Use --browser=<path-or-name>." >&2
    exit 1
fi

USER_DATA_DIR="$(mktemp -d -t wasm-dbi-dac-demo-XXXXXX)"

cleanup() {
    local rc=$?
    set +e
    if [ -n "${WATCHER_PID:-}" ] && kill -0 "$WATCHER_PID" 2>/dev/null; then
        echo "==> stopping cdp-driver watcher (PID ${WATCHER_PID})"
        kill "$WATCHER_PID" 2>/dev/null
        sleep 0.3
        kill -9 "$WATCHER_PID" 2>/dev/null
    fi
    if [ -n "${BROWSER_PID:-}" ] && kill -0 "$BROWSER_PID" 2>/dev/null; then
        echo "==> stopping browser (PID ${BROWSER_PID})"
        kill "$BROWSER_PID" 2>/dev/null
        sleep 0.3
        kill -9 "$BROWSER_PID" 2>/dev/null
    fi
    if [ -n "${SERVE_PID:-}" ] && kill -0 "$SERVE_PID" 2>/dev/null; then
        echo "==> stopping dotnet serve (PID ${SERVE_PID})"
        kill "$SERVE_PID" 2>/dev/null
        sleep 0.3
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

# Step 1: dotnet serve (or reuse existing one)
SERVE_OWNED=1
if curl -fsS "http://localhost:${PORT}/" >/dev/null 2>&1; then
    echo "==> reusing existing http server on port ${PORT}"
    SERVE_OWNED=0
else
    echo "==> dotnet serve on port ${PORT}"
    dotnet serve -d "${ARTIFACT_DIR}" -p "${PORT}" >/tmp/wasm-dbi-dac-serve.log 2>&1 &
    SERVE_PID=$!
    SERVE_READY=0
    for i in $(seq 1 60); do
        if curl -fsS "http://localhost:${PORT}/" >/dev/null 2>&1; then SERVE_READY=1; break; fi
        if ! kill -0 "$SERVE_PID" 2>/dev/null; then break; fi
        sleep 0.5
    done
    if [ "${SERVE_READY}" -ne 1 ]; then
        echo "Error: dotnet serve did not come up on port ${PORT}" >&2
        cat /tmp/wasm-dbi-dac-serve.log >&2 || true
        exit 1
    fi
fi

# Step 2: launch chrome on /index.html with the CDP port open
INDEX_URL="http://localhost:${PORT}/index.html"
echo "==> launching browser: ${BROWSER_BIN}"
echo "==>   --remote-debugging-port=${CDP_PORT}"
echo "==>   --user-data-dir=${USER_DATA_DIR}"
echo "==>   URL: ${INDEX_URL}"

"${BROWSER_BIN}" \
    --remote-debugging-port="${CDP_PORT}" \
    --user-data-dir="${USER_DATA_DIR}" \
    --no-first-run \
    --no-default-browser-check \
    --new-window \
    "${INDEX_URL}" \
    >/tmp/wasm-dbi-dac-browser.log 2>&1 &
BROWSER_PID=$!

# Wait for CDP endpoint
echo "==> waiting for CDP endpoint http://localhost:${CDP_PORT}/json/version ..."
CDP_READY=0
for i in $(seq 1 60); do
    if curl -fsS "http://localhost:${CDP_PORT}/json/version" >/dev/null 2>&1; then CDP_READY=1; break; fi
    sleep 0.5
done
if [ "${CDP_READY}" -ne 1 ]; then
    echo "Error: CDP endpoint did not come up on port ${CDP_PORT}" >&2
    cat /tmp/wasm-dbi-dac-browser.log >&2 || true
    exit 1
fi
echo "==> CDP endpoint is live"

# Step 3: run cdp-driver in watch mode (foreground). Whenever the user
# navigates a tab to hello-async-break.html?wait-for-external-dbi=1
# (e.g. by clicking the link in index.html), the watcher drives the
# 8-step IDE/mscordbi demo on that tab.
echo "==> starting cdp-driver.mjs --watch in background"
echo "==> open the smoke index in the browser window that just opened"
echo "==> and click 'hello-async-break' to trigger the IDE-driven demo"
echo "==> (Ctrl-C in this terminal to tear down)"
echo
node cdp-driver.mjs --port="${CDP_PORT}" --watch &
WATCHER_PID=$!

# Block until the user closes the browser or Ctrl-Cs.
wait "${BROWSER_PID}" 2>/dev/null || true
