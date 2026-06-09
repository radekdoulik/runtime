// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

import { test, expect } from '@playwright/test';

async function cdpEvaluate(cdp, expression) {
  const response = await cdp.send('Runtime.evaluate', { expression, returnByValue: true });
  if (response.exceptionDetails !== undefined) {
    throw new Error(`Runtime.evaluate failed: ${response.exceptionDetails.text}`);
  }

  return response.result.value;
}

test('hello-async-break smoke', async ({ page }) => {
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

  // Attach a CDP session BEFORE loading the page so that V8's debugger
  // is armed before the cooperative-break callback executes the
  // `debugger;` statement. With Debugger.enable, V8 will emit
  // Debugger.paused at that statement and freeze the wasm caller
  // until Debugger.resume — demonstrating that the cooperative path
  // can actually be used to hand control to the IDE.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Runtime.enable');
  await cdp.send('Debugger.enable');
  await cdp.send('Debugger.setSkipAllPauses', { skip: false });

  // Auto-resume any incidental Debugger.paused that is NOT tagged as
  // the cooperative async-break. The libCorerun.js wrapper for
  // coreClrDebugFireEventToPause executes `debugger;` for EVERY event
  // the runtime fires (module load, breakpoint, async-break) — so we
  // need the page-side handler to tag the upcoming pause via
  // globalThis.__lastFiredEventKind. We then read it from the spec
  // when Debugger.paused fires and only apply the 5-second hold for
  // the async-break case.
  let cooperativePauseDetails = null;
  const cooperativePauseSeen = new Promise(resolve => {
    cdp.on('Debugger.paused', async event => {
      const isLibCorerun = event.callFrames.some(f =>
        (f.url || '').endsWith('libCorerun.js') ||
        (f.functionName || '').includes('coreClrDebugFireEventToPause'));
      let kind = null;
      if (isLibCorerun) {
        try {
          kind = await cdpEvaluate(cdp, 'globalThis.__lastFiredEventKind || null');
        } catch {
          // ignore — evaluation may fail if the page is in an
          // intermediate state; treat as non-cooperative
        }
      }
      if (!isLibCorerun || kind !== 'async-break') {
        console.log('[spec] auto-resume non-cooperative pause: isLibCorerun=' + isLibCorerun + ' kind=' + kind +
          ' topFrame=' + (event.callFrames[0]?.functionName || event.callFrames[0]?.url));
        await cdp.send('Debugger.resume').catch(() => {});
        return;
      }

      cooperativePauseDetails = {
        reason: event.reason,
        topFrame: event.callFrames[0]?.functionName || event.callFrames[0]?.url || '',
        kind
      };
      console.log('[spec] cooperative Debugger.paused: ' + JSON.stringify(cooperativePauseDetails));
      resolve(event);
    });
  });

  await page.goto('/hello-async-break.html');
  await cooperativePauseSeen;

  // V8 has frozen the wasm caller via the `debugger;` statement that
  // libCorerun.js executes immediately after our user-handler returns.
  // The user handler already drained the structured event AND read
  // the locals schema from the runtime via DAC enumerate_locals
  // before returning, so the simulated-pause panel is fully populated
  // and visible to anyone watching the browser window.
  const progressAtPause = await cdpEvaluate(cdp, 'globalThis.__smokeProgress');
  console.log('[spec] progressAtPause=' + progressAtPause);

  // Prove the runtime is actually halted by sampling progress across
  // a quiet window — no managed work runs while V8 holds the JS frame.
  await page.waitForTimeout(500);
  const progressAfterQuiet = await cdpEvaluate(cdp, 'globalThis.__smokeProgress');
  expect(progressAfterQuiet).toBe(progressAtPause);

  // Simulate the IDE keeping the runtime paused while a human looks at
  // the locals/stack pane. The 5-second wait is what the user explicitly
  // asked for in the demo: pause, render data, hold for 5 seconds, then
  // resume via CDP Debugger.resume. The page remains visibly frozen for
  // the full window.
  await page.waitForTimeout(5000);
  const progressAfterSimulatedHold = await cdpEvaluate(cdp, 'globalThis.__smokeProgress');
  expect(progressAfterSimulatedHold).toBe(progressAtPause);

  // Tell the IDE-side to release the runtime. The libCorerun wrapper
  // then returns to wasm, the runtime clears the async-break flag,
  // and the loop runs to completion.
  await cdp.send('Debugger.resume');
  console.log('[spec] Debugger.resume issued after 5s hold');

  await page.waitForFunction(() => globalThis.__smokeResult !== undefined, null, { timeout: 60000 });
  const result = await page.evaluate(() => globalThis.__smokeResult);
  if (!result.passed) console.error('Smoke failed:', result.error);
  expect(result.passed).toBe(true);
  expect(result.result.tickCountAtAsyncBreak).toBeGreaterThan(30);
  expect(result.result.tickCountAtAsyncBreak).toBeLessThan(90);
  expect(Math.abs(progressAtPause - result.result.tickCountAtAsyncBreak)).toBeLessThanOrEqual(2);
  expect(result.result.localsAtAsyncBreak.pollResult).toBe(0);
  expect(result.result.localsAtAsyncBreak.record?.localCount ?? 0).toBeGreaterThan(0);
  console.log(JSON.stringify({
    tickCountAtAsyncBreak: result.result.tickCountAtAsyncBreak,
    progressAtPause,
    progressAfterQuiet,
    progressAfterSimulatedHold,
    finalTickCount: result.result.finalTickCount,
    localsRead: result.result.localsAtAsyncBreak.record?.localCount ?? 0,
    cooperativePauseDetails
  }, null, 2));
});
