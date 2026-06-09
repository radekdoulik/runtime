// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

import { test, expect } from '@playwright/test';

function waitForCdpEvent(cdp, eventName, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cdp.off(eventName, onEvent);
      reject(new Error(`${eventName} was not observed within ${timeoutMs}ms`));
    }, timeoutMs);
    const onEvent = event => {
      clearTimeout(timer);
      cdp.off(eventName, onEvent);
      resolve(event);
    };
    cdp.on(eventName, onEvent);
  });
}

async function cdpEvaluate(cdp, expression) {
  const response = await cdp.send('Runtime.evaluate', { expression, returnByValue: true });
  if (response.exceptionDetails !== undefined) {
    throw new Error(`Runtime.evaluate failed: ${response.exceptionDetails.text}`);
  }

  return response.result.value;
}

test('hello-cdp-pause smoke', async ({ page }) => {
  let observedProgress = 0;
  const progressWaiters = [];
  page.on('console', msg => {
    const text = msg.text();
    const match = text.match(/\[runtime\] keepalive-tick (\d+)/);
    if (match !== null) {
      const tick = Number(match[1]);
      if (tick % 100 === 0) {
        console.log('[page]', text);
      }
      observedProgress = Math.max(observedProgress, tick + 1);
      for (const waiter of [...progressWaiters]) {
        if (observedProgress > waiter.minProgress) {
          progressWaiters.splice(progressWaiters.indexOf(waiter), 1);
          clearTimeout(waiter.timer);
          waiter.resolve(observedProgress);
        }
      }
    } else {
      console.log('[page]', text);
    }
  });

  function waitForObservedProgress(minProgress, timeoutMs) {
    if (observedProgress > minProgress) {
      return Promise.resolve(observedProgress);
    }

    return new Promise((resolve, reject) => {
      const waiter = {
        minProgress,
        resolve,
        timer: setTimeout(() => {
          const index = progressWaiters.indexOf(waiter);
          if (index >= 0) {
            progressWaiters.splice(index, 1);
          }
          reject(new Error(`observed progress did not exceed ${minProgress} within ${timeoutMs}ms`));
        }, timeoutMs)
      };
      progressWaiters.push(waiter);
    });
  }

  await page.goto('/hello-cdp-pause.html?startDelayMs=3000');
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Runtime.enable');
  await cdp.send('Debugger.enable');
  await cdp.send('Debugger.setSkipAllPauses', { skip: false });
  await cdp.send('Runtime.runIfWaitingForDebugger');

  const progressBeforePause = await waitForObservedProgress(100, 60000);
  const pauseStart = performance.now();
  const paused = waitForCdpEvent(cdp, 'Debugger.paused', 15000);
  await cdp.send('Debugger.pause');
  await paused;
  const pauseMs = performance.now() - pauseStart;

  const progressAtPause = await cdpEvaluate(cdp, 'globalThis.__smokeProgress');
  expect(progressAtPause).toBeGreaterThanOrEqual(progressBeforePause);
  expect(progressAtPause).toBeLessThan(1000);

  await page.waitForTimeout(500);
  const progressAfterQuiet = await cdpEvaluate(cdp, 'globalThis.__smokeProgress');
  expect(progressAfterQuiet).toBe(progressAtPause);

  const resumeStart = performance.now();
  const resumed = waitForCdpEvent(cdp, 'Debugger.resumed', 15000);
  await cdp.send('Debugger.resume');
  await resumed;
  const resumeMs = performance.now() - resumeStart;

  await page.waitForFunction(() => globalThis.__smokeResult !== undefined, null, { timeout: 90000 });
  const result = await page.evaluate(() => globalThis.__smokeResult);
  if (!result.passed) console.error('Smoke failed:', result.error);
  expect(result.passed).toBe(true);
  expect(result.result.tickCount).toBeGreaterThan(progressAfterQuiet);
  console.log(JSON.stringify({
    pauseMs: Math.round(pauseMs),
    resumeMs: Math.round(resumeMs),
    progressBeforePause,
    progressAtPause,
    progressAfterQuiet,
    finalProgress: result.result.tickCount
  }, null, 2));
});
