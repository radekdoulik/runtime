// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

// hello-async-break (browser) — DBI/IDE orchestration via CDP.
//
// The PAGE is a passive runtime host (see hello-async-break.mjs). This
// test plays the IDE+DBI role. The full flow is:
//
//   1. Attach CDP (the IDE's transport to the runtime).
//   2. Wait for the managed busy loop to be mid-flight (progress > 30).
//   3. IDE issues `Debugger.pause` — V8 freezes the runtime thread.
//   4. While V8-paused, DBI writes the runtime's atomic async-break
//      flag (g_wasmDebugAsyncBreakInProgress) directly into runtime
//      memory at the cached address. The runtime cannot run its own
//      setter while paused; direct memory write is the only path.
//   5. IDE issues `Debugger.resume` — V8 unfreezes the runtime.
//   6. The runtime continues until the next IL sequence point. At that
//      INTOP_DEBUG_SEQ_POINT the interpreter reads the flag, calls
//      EmitWasmDebugAsyncBreak, populates the structured event and
//      the locals schema, and calls the JS stop trigger. The
//      libCorerun.js wrapper executes `debugger;` immediately after
//      our (minimal, page-side) JS handler returns — V8 emits
//      `Debugger.paused` and freezes the runtime thread again.
//   7. DBI inspects via CDP `Runtime.evaluate` calling the page-side
//      `__dbi.pollAsyncBreakEvent()` and `__dbi.pollLocals()` —
//      these are real DBI/DAC round-trips through the sidecar.
//   8. DBI renders the result in the page DOM via `__dbi.renderPausePanel`
//      so a human watching the browser sees the locals.
//   9. DBI holds for 5 seconds (simulated IDE "user looking at debugger").
//  10. IDE issues `Debugger.resume` — wasm continues, the runtime
//      clears the async-break flag, the loop runs to completion.

import { test, expect } from '@playwright/test';

async function cdpEvaluate(cdp, expression) {
  const response = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: false });
  if (response.exceptionDetails !== undefined) {
    throw new Error(`Runtime.evaluate failed: ${response.exceptionDetails.text} | expr: ${expression}`);
  }

  return response.result.value;
}

function waitForCdpEvent(cdp, eventName, predicate, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cdp.off(eventName, onEvent);
      reject(new Error(`${eventName} (matching predicate) was not observed within ${timeoutMs}ms`));
    }, timeoutMs);
    const onEvent = event => {
      if (!predicate(event)) {
        return;
      }
      clearTimeout(timer);
      cdp.off(eventName, onEvent);
      resolve(event);
    };
    cdp.on(eventName, onEvent);
  });
}

async function waitFor(probe, description, timeoutMs, intervalMs = 50) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value !== undefined && value !== null && value !== false) {
      return value;
    }
    await new Promise(r => setTimeout(r, intervalMs));
  }
  throw new Error(`timed out waiting for ${description} (${timeoutMs}ms)`);
}

test('hello-async-break smoke (DBI/CDP orchestration)', async ({ page }) => {
  let observedProgress = 0;
  page.on('console', msg => {
    const t = msg.text();
    const match = t.match(/\[runtime\] keepalive-tick (\d+)/);
    if (match !== null) {
      observedProgress = Math.max(observedProgress, Number(match[1]) + 1);
      return;
    }

    console.log('[page]', t);
  });

  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Runtime.enable');
  await cdp.send('Debugger.enable');
  await cdp.send('Debugger.setSkipAllPauses', { skip: false });

  // The libCorerun.js wrapper runs `debugger;` for EVERY event the
  // runtime fires (module load, breakpoint, async-break...). We have
  // to auto-resume incidental pauses so they don't deadlock the test,
  // and only treat the async-break tagged pause as the real signal.
  const autoResumeUnknown = (event) => {
    const isLibCorerun = event.callFrames.some(f =>
      (f.url || '').endsWith('libCorerun.js') ||
      (f.functionName || '').includes('coreClrDebugFireEventToPause'));
    return isLibCorerun;
  };
  // Catch-all incidental-pause auto-resumer. Stays armed for the
  // entire test. We do NOT use it for the cooperative pause (we
  // detect that pause with an explicit waitForCdpEvent predicate).
  cdp.on('Debugger.paused', async event => {
    if (!autoResumeUnknown(event)) {
      return;
    }
    let kind = null;
    try {
      kind = await cdpEvaluate(cdp, 'globalThis.__lastFiredEventKind || null');
    } catch {
      // ignore
    }
    if (kind === 'async-break') {
      // Cooperative pause: the test's explicit waitForCdpEvent picks
      // this up and orchestrates the rest. Do nothing here.
      return;
    }
    console.log('[spec] auto-resume incidental libCorerun pause: kind=' + kind);
    await cdp.send('Debugger.resume').catch(() => {});
  });

  // Use the same wait-for-external-dbi gate the Chrome extension uses
  // — ensures CDP Debugger.enable runs before the page loads sidecar
  // or runtime wasm. This is the moment a real ICorDebug session
  // would attach.
  await page.goto('/hello-async-break.html?wait-for-external-dbi=1');
  await cdpEvaluate(cdp, 'globalThis.__externalDbiReady = true');

  // Wait until the runtime + sidecar are up, the DBI session is
  // connected, and the page has exposed the __dbi facade.
  await waitFor(
    async () => await cdpEvaluate(cdp, 'globalThis.__dbiReady === true'),
    '__dbi facade ready',
    60000);
  console.log('[spec] DBI facade ready');

  // Wait for the busy loop to be safely mid-flight so the async-break
  // doesn't race the loop's startup. We anchor on observedProgress
  // (parsed from console output) rather than __smokeProgress (a page
  // global) so we see real loop progress, not stale state.
  await waitFor(
    () => Promise.resolve(observedProgress > 30 ? observedProgress : false),
    'observedProgress > 30',
    60000);
  console.log('[spec] loop mid-flight at observedProgress=' + observedProgress);

  // === STEP 1: DBI pauses runtime via CDP ===
  // This is the entry point of the IDE/DBI flow. From this moment,
  // the runtime cannot make managed progress until we explicitly
  // Debugger.resume it.
  console.log('[spec] [DBI step 1] CDP Debugger.pause');
  const initialPaused = waitForCdpEvent(cdp, 'Debugger.paused',
    e => e.reason === 'other' || e.reason === 'debugCommand',
    15000);
  await cdp.send('Debugger.pause');
  await initialPaused;
  const stateAtIdePause = await cdpEvaluate(cdp, 'JSON.stringify(globalThis.__dbi.getState())');
  console.log('[spec] [DBI step 1] V8 frozen; state=' + stateAtIdePause);

  // === STEP 2: DBI sets the atomic async-break flag via direct memory write ===
  // The runtime is V8-paused so its own CoreClrWasmDebugSetAsyncBreakInProgress
  // export cannot be invoked — we write the 1-byte flag straight into
  // runtime memory at the cached address. This is the moment that
  // tells the runtime "halt at the next safepoint".
  console.log('[spec] [DBI step 2] writing async-break flag atomically');
  const flagWriteResult = await cdpEvaluate(cdp,
    'JSON.stringify({ previous: globalThis.__dbi.setAsyncBreakFlag(1), current: globalThis.__dbi.getState().asyncBreakFlagValue })');
  console.log('[spec] [DBI step 2] flag write: ' + flagWriteResult);
  expect(JSON.parse(flagWriteResult).current).toBe(1);

  // === STEP 3: DBI resumes runtime; it now runs until the next safepoint ===
  console.log('[spec] [DBI step 3] CDP Debugger.resume (runtime will halt at next IL sequence point)');
  const cooperativePaused = waitForCdpEvent(cdp, 'Debugger.paused', e => {
    const isLibCorerun = e.callFrames.some(f =>
      (f.url || '').endsWith('libCorerun.js') ||
      (f.functionName || '').includes('coreClrDebugFireEventToPause'));
    return isLibCorerun;
  }, 30000);
  await cdp.send('Debugger.resume');

  // === STEP 4: DBI awaits the cooperative halt ===
  // The libCorerun.js wrapper's `debugger;` halts V8 at the cooperative
  // break point. The runtime has already populated the structured
  // async-break event AND the locals schema by the time we get here.
  const cooperativeEvent = await cooperativePaused;
  const tag = await cdpEvaluate(cdp, 'globalThis.__lastFiredEventKind || null');
  expect(tag).toBe('async-break');
  console.log('[spec] [DBI step 4] cooperative halt observed: kind=' + tag +
    ' topFrame=' + (cooperativeEvent.callFrames[0]?.functionName || cooperativeEvent.callFrames[0]?.url));

  // === STEP 5: DBI polls the structured event + locals via DAC ===
  console.log('[spec] [DBI step 5] polling event + locals via sidecar DAC');
  const eventJson = await cdpEvaluate(cdp, 'JSON.stringify(globalThis.__dbi.pollAsyncBreakEvent())');
  const localsJson = await cdpEvaluate(cdp, 'JSON.stringify(globalThis.__dbi.pollLocals())');
  const event = JSON.parse(eventJson);
  const locals = JSON.parse(localsJson);
  expect(event.pollResult).toBe(0);
  expect(event.payload).not.toBeNull();
  expect(locals.pollResult).toBe(0);
  expect(locals.record?.localCount ?? 0).toBeGreaterThan(0);

  // === STEP 6: DBI renders the result in the page DOM ===
  console.log('[spec] [DBI step 6] rendering pause panel in browser');
  const message = `Simulating IDE debug pause (5s hold; runtime halted at IL=${event.payload.ilOffset} in method=${event.payload.funcMetadataToken})`;
  await cdpEvaluate(cdp,
    `globalThis.__dbi.renderPausePanel(${JSON.stringify(message)}, ${JSON.stringify(event.payload)}, ${JSON.stringify(locals.record)})`);

  // === STEP 7: DBI holds for 5 seconds (simulated "user looking at debugger") ===
  // The runtime is still V8-frozen at the libCorerun debugger; statement.
  // Prove it: the progress reported by the page-side line scanner does
  // not advance while we hold.
  const progressBeforeHold = await cdpEvaluate(cdp, 'globalThis.__smokeProgress');
  console.log('[spec] [DBI step 7] holding 5s; progressBeforeHold=' + progressBeforeHold);
  const holdStart = Date.now();
  await page.waitForTimeout(5000);
  const holdActualMs = Date.now() - holdStart;
  const progressAfterHold = await cdpEvaluate(cdp, 'globalThis.__smokeProgress');
  console.log('[spec] [DBI step 7] hold complete after ' + holdActualMs + 'ms; progressAfterHold=' + progressAfterHold);
  expect(progressAfterHold).toBe(progressBeforeHold);

  // === STEP 8: DBI resumes runtime via CDP ===
  console.log('[spec] [DBI step 8] CDP Debugger.resume (runtime continues to completion)');
  await cdp.send('Debugger.resume');

  // === STEP 9: Wait for the loop to complete and validate ===
  await page.waitForFunction(() => globalThis.__smokeResult !== undefined, null, { timeout: 60000 });
  const result = await page.evaluate(() => globalThis.__smokeResult);
  if (!result.passed) console.error('Smoke failed:', result.error);
  expect(result.passed).toBe(true);
  expect(result.result.tickCount).toBe(120);
  expect(result.result.asyncBreakFireEventToPauseCount).toBeGreaterThan(0);

  console.log(JSON.stringify({
    progressBeforeHold,
    progressAfterHold,
    holdActualMs,
    finalTickCount: result.result.tickCount,
    asyncBreakEvent: { token: event.payload.asyncBreakToken, ilOffset: event.payload.ilOffset, funcMetadataToken: event.payload.funcMetadataToken },
    localsCount: locals.record.localCount,
    fireEventToPauseCount: result.result.fireEventToPauseCount,
    asyncBreakFireEventToPauseCount: result.result.asyncBreakFireEventToPauseCount
  }, null, 2));
});
