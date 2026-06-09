// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

import { test, expect } from '@playwright/test';

test('hello-async-break smoke', async ({ page }) => {
  page.on('console', msg => {
    const t = msg.text();
    if (!t.includes('keepalive-tick ')) console.log('[page]', t);
  });
  await page.goto('/hello-async-break.html');
  await page.waitForFunction(() => globalThis.__smokeResult !== undefined, null, { timeout: 120000 });
  const result = await page.evaluate(() => globalThis.__smokeResult);
  if (!result.passed) console.error('Smoke failed:', result.error);
  expect(result.passed).toBe(true);
  // Cooperative async-break should land in the middle of the loop
  // (NOT at tick 1, which would mean the break flag was set before
  // the loop was actually running — the bug that motivated anchoring
  // the timer to keepalive-begin).
  expect(result.result.tickCountAtAsyncBreak).toBeGreaterThan(30);
  expect(result.result.tickCountAtAsyncBreak).toBeLessThan(90);
});
