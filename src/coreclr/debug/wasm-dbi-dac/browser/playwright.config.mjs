// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

export default {
  timeout: 120000,
  testDir: './tests',
  use: { headless: true, baseURL: 'http://localhost:8080' },
  webServer: {
    command: 'node prepare.mjs && node serve.mjs --port=8080',
    url: 'http://localhost:8080/',
    reuseExistingServer: !process.env.CI,
    timeout: 120000
  }
};
