# WASM CoreCLR DBI/DAC demo — Chrome extension

This unpacked Chrome extension plays the **ICorDebug/mscordbi** role
over the CDP `chrome.debugger` API, driving the in-browser CoreCLR
wasm runtime + sidecar to perform a full IDE-driven async-break +
locals-inspect demo — exactly the flow a real ICorDebug-attached
mscordbi adapter would take, just hosted inside the browser as an
extension.

## Loading the extension

1. Build + stage the smoke harness once:

   ```bash
   cd src/coreclr/debug/wasm-dbi-dac/browser
   node prepare.mjs
   ```

2. Start a local server:

   ```bash
   ./serve-smokes.sh
   ```

3. In Chrome (or Edge), open `chrome://extensions`, toggle
   **Developer mode** on, click **Load unpacked**, and pick this
   directory (`src/coreclr/debug/wasm-dbi-dac/browser/extension/`).

4. Open the demo page:

   ```
   http://localhost:8080/hello-async-break.html?wait-for-external-dbi=1
   ```

   The page blocks at `waiting for external DBI extension to attach`.

5. Click the extension's action icon (toolbar) → **Run IDE-driven
   async-break demo**. The popup logs each orchestration step; the
   page renders the structured async-break event + locals schema
   pulled via the sidecar DAC; the runtime is genuinely frozen for
   5 s; then the loop completes to tick 120.

If you open `hello-async-break.html` WITHOUT the
`?wait-for-external-dbi=1` query parameter, the extension will
reload the tab with it added before attaching.

## What the extension does

```
[step 0]  chrome.debugger.attach + Runtime.enable + Debugger.enable
[step 0b] release the page (sets globalThis.__externalDbiReady = true)
[step 0c] wait for the page __dbi facade
[step 0d] wait for the managed busy loop to be mid-flight
[step 1]  CDP Debugger.pause          → V8 freezes the runtime thread
[step 2]  write the runtime's atomic async-break flag directly into
          runtime memory (the runtime is paused; the page __dbi facade
          does the 1-byte write to runtime.memory.buffer[asyncBreakFlagAddress])
[step 3]  CDP Debugger.resume         → runtime runs until next IL safepoint
[step 4]  wait for cooperative halt   → libCorerun.js debugger; fires
                                        after EmitWasmDebugAsyncBreak
                                        populates the structured event
                                        + locals schema record
[step 5]  poll the structured event + locals schema via the sidecar DAC
          (coreclr_wasm_dbi_dac_dbi_poll_async_break_complete +
           coreclr_wasm_dbi_dac_dbi_enumerate_locals — real
           DAC round-trips into the frozen runtime's memory)
[step 6]  render the pause panel in the page DOM
[step 7]  5-second hold (simulated IDE user looking at debugger UI;
          progressBeforeHold === progressAfterHold proves the runtime
          is genuinely frozen)
[step 8]  CDP Debugger.resume         → loop runs to completion
```

This is the same orchestration the Playwright spec runs in
`tests/hello-async-break.spec.mjs` — but here it executes inside a
real Chrome window, driven by a real Chrome extension speaking real
CDP, with no test framework involved.
