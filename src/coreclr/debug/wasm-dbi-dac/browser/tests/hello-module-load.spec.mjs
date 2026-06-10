// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

import { test, expect } from '@playwright/test';

test('hello-module-load smoke', async ({ page }) => {
  page.on('console', msg => console.log('[page]', msg.text()));
  await page.goto('/hello-module-load.html');
  await page.waitForFunction(() => globalThis.__smokeResult !== undefined, null, { timeout: 60000 });
  const result = await page.evaluate(() => globalThis.__smokeResult);
  if (!result.passed) console.error('Smoke failed:', result.error);
  expect(result.passed).toBe(true);
  expect(result.result.eventCount).toBeGreaterThanOrEqual(1);
});
