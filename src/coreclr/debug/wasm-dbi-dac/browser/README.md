# Browser hello-breakpoint smoke

## Quick start

```bash
cd src/coreclr/debug/wasm-dbi-dac/browser
node prepare.mjs
node serve.mjs
```

Open `http://localhost:8080/hello-breakpoint.html` or `http://localhost:8080/hello-async-break.html` in Chrome. Each page runs its smoke and renders PASS/FAIL plus the structured assertion details.

## Manual Chrome

1. Build the wasm artifacts if needed: `cd ../../../../../artifacts/obj/coreclr/browser.wasm.Debug && ninja coreclr_dbi_dac_wasm corerun`.
2. `cd src/coreclr/debug/wasm-dbi-dac/browser`.
3. Run `node prepare.mjs`.
4. Run `node serve.mjs --port=8080`.
5. Open `http://localhost:8080/hello-breakpoint.html` in Chrome.
6. Optional: open DevTools after the page passes and inspect `window.__smokeResult` in the console. If DevTools pauses on the runtime `debugger;` stop trigger, resume once to let the smoke finish.

### hello-async-break

1. Build the wasm artifacts if needed: `cd ../../../../../artifacts/obj/coreclr/browser.wasm.Debug && ninja coreclr_dbi_dac_wasm corerun`.
2. `cd src/coreclr/debug/wasm-dbi-dac/browser`.
3. Run `node prepare.mjs`.
4. Run `node serve.mjs --port=8080`.
5. Open `http://localhost:8080/hello-async-break.html` in Chrome.
6. Open DevTools immediately (F12 or ⌥⌘I). The page waits briefly before loading WebAssembly so DevTools can send `Debugger.enable` before the wasm modules instantiate.
7. Press the DevTools **Pause** button, or F8, while the managed `KeepAlive` loop is running. Watch the tick count and runtime console ticks freeze.
8. Press **Resume** (F8) and watch the loop continue to completion. The page reports PASS when `window.__smokeResult.passed === true`.

## Playwright

One-time setup from this directory:

```bash
npm install --no-save --no-package-lock @playwright/test
npx playwright install chromium
```

Run the automated browser smokes:

```bash
npx playwright test
```

`playwright.config.mjs` runs `node prepare.mjs`, starts `node serve.mjs --port=8080`, and drives headless Chromium against the same pages used manually.

`tests/hello-async-break.spec.mjs` attaches a CDP session to the page, sends `Debugger.enable` before the delayed WebAssembly startup, waits for the managed `KeepAlive` loop to make progress, sends `Debugger.pause`, verifies progress stops while paused, sends `Debugger.resume`, and verifies the loop completes.

## Architecture

```text
prepare.mjs
  ├─ copies corerun.{js,wasm} and coreclr-dbi-dac.{js,wasm}
  ├─ builds HelloBreakpoint.dll + Portable PDB with dotnet.sh
  ├─ builds HelloAsyncBreak.dll with dotnet.sh
  └─ writes manifest.json + source-location-map.json

serve.mjs
  ├─ serves this browser harness directory
  ├─ serves artifacts/wasm-dbi-dac-browser-smoke/
  └─ serves shared-framework DLLs from artifacts/bin/testhost/...

hello-breakpoint.html
  └─ imports hello-breakpoint.mjs
       └─ uses host.mjs to instantiate corerun.wasm and coreclr-dbi-dac.wasm,
          wire the host imports, set BreakHereWithLocals, validate the stop,
          locals, values, source mapping, continue, disconnect, and expose
          window.__smokeResult.

hello-async-break.html
  └─ delays startup so DevTools/CDP can enable the debugger before wasm
     instantiation, then imports hello-async-break.mjs
       └─ uses host.mjs to instantiate corerun.wasm and coreclr-dbi-dac.wasm,
          connect a DBI session, run the managed KeepAlive loop, publish
          window.__smokeProgress tick markers, and expose window.__smokeResult.
```
