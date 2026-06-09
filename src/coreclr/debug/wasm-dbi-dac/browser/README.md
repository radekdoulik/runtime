# Browser hello-breakpoint smoke

## Quick start

```bash
cd src/coreclr/debug/wasm-dbi-dac/browser
node prepare.mjs
node serve.mjs
```

Open `http://localhost:8080/hello-breakpoint.html` in Chrome. The page runs the smoke and renders PASS/FAIL plus the structured assertion details.

## Manual Chrome

1. Build the wasm artifacts if needed: `cd ../../../../../artifacts/obj/coreclr/browser.wasm.Debug && ninja coreclr_dbi_dac_wasm corerun`.
2. `cd src/coreclr/debug/wasm-dbi-dac/browser`.
3. Run `node prepare.mjs`.
4. Run `node serve.mjs --port=8080`.
5. Open `http://localhost:8080/hello-breakpoint.html` in Chrome.
6. Optional: open DevTools after the page passes and inspect `window.__smokeResult` in the console. If DevTools pauses on the runtime `debugger;` stop trigger, resume once to let the smoke finish.

## Playwright

One-time setup from this directory:

```bash
npm install --no-save --no-package-lock @playwright/test
npx playwright install chromium
```

Run the automated browser smoke:

```bash
npx playwright test
```

`playwright.config.mjs` runs `node prepare.mjs`, starts `node serve.mjs --port=8080`, and drives headless Chromium against the same `hello-breakpoint.html` page used manually.

## Architecture

```text
prepare.mjs
  ├─ copies corerun.{js,wasm} and coreclr-dbi-dac.{js,wasm}
  ├─ builds HelloBreakpoint.dll + Portable PDB with dotnet.sh
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
```
