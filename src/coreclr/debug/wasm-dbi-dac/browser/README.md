# Browser hello-breakpoint smoke

## Quick start

Prerequisite if you do not already have `dotnet serve`:

```bash
dotnet tool install -g dotnet-serve
```

### Manual (Chrome)

```bash
cd src/coreclr/debug/wasm-dbi-dac/browser
./serve-smokes.sh                # macOS/Linux
serve-smokes.cmd                 # Windows
```

The script runs `prepare.mjs` then `dotnet serve` on port 8080. Open in Chrome:
- `http://localhost:8080/hello-breakpoint.html`
- `http://localhost:8080/hello-async-break.html`

### Automated (Playwright)

```bash
cd src/coreclr/debug/wasm-dbi-dac/browser
./run-smokes.sh                  # macOS/Linux — headless Chromium
run-smokes.cmd                   # Windows — headless Chromium
```

The first run installs `@playwright/test` + Chromium under `node_modules/` (skipped on subsequent runs).

Flags:
- `--headed` — visible Chromium window (useful for debugging)
- `--smoke=<name>` — run a single smoke (e.g. `--smoke=hello-async-break`)
- `--skip-prepare` — skip the `prepare.mjs` step if artifacts are already staged

## Manual Chrome

The `serve-smokes.sh` / `serve-smokes.cmd` script handles the build + serve steps above; the long-form below is the manual equivalent if you prefer to run each command yourself.

1. Build the wasm artifacts if needed: `cd ../../../../../artifacts/obj/coreclr/browser.wasm.Debug && ninja coreclr_dbi_dac_wasm corerun`.
2. `cd src/coreclr/debug/wasm-dbi-dac/browser`.
3. Run `node prepare.mjs`.
4. Run `dotnet serve -d ../../../../../artifacts/wasm-dbi-dac-browser-smoke -p 8080`.
5. Open `http://localhost:8080/hello-breakpoint.html` in Chrome.
6. Optional: open DevTools after the page passes and inspect `window.__smokeResult` in the console. If DevTools pauses on the runtime `debugger;` stop trigger, resume once to let the smoke finish.

### hello-async-break

1. Run `./serve-smokes.sh` (or `serve-smokes.cmd`) as above.
2. Open `http://localhost:8080/hello-async-break.html` in Chrome.
3. Open DevTools immediately (F12 or ⌥⌘I). The page waits briefly before loading WebAssembly so DevTools can send `Debugger.enable` before the wasm modules instantiate.
4. Press the DevTools **Pause** button, or F8, while the managed `KeepAlive` loop is running. Watch the tick count and runtime console ticks freeze.
5. Press **Resume** (F8) and watch the loop continue to completion. The page reports PASS when `window.__smokeResult.passed === true`.

## Playwright

The `run-smokes.sh` / `run-smokes.cmd` script handles install + invocation; the long-form below is the manual equivalent.

One-time setup from this directory:

```bash
npm install --no-save --no-package-lock @playwright/test
npx playwright install chromium
```

Run the automated browser smokes:

```bash
npx playwright test
```

`playwright.config.mjs` starts `dotnet serve` for the staged artifact directory and drives headless Chromium against the same pages used manually. Run `node prepare.mjs` first when artifacts need to be built or refreshed.

`tests/hello-async-break.spec.mjs` attaches a CDP session to the page, sends `Debugger.enable` before the delayed WebAssembly startup, waits for the managed `KeepAlive` loop to make progress, sends `Debugger.pause`, verifies progress stops while paused, sends `Debugger.resume`, and verifies the loop completes.

The staged shared framework is a directory symlink on macOS/Linux to avoid copying hundreds of files. Browser HTML and `.mjs` files are copied because `dotnet serve` serves file symlinks as link files instead of following them.

## Architecture

```text
prepare.mjs
  ├─ copies corerun.{js,wasm} and coreclr-dbi-dac.{js,wasm}
  ├─ builds HelloBreakpoint.dll + Portable PDB with dotnet.sh
  ├─ builds HelloAsyncBreak.dll with dotnet.sh
  ├─ writes manifest.json + source-location-map.json
  └─ stages HTML, browser modules, and shared-framework symlinks under
     artifacts/wasm-dbi-dac-browser-smoke/

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
