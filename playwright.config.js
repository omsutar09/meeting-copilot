// End-to-end tests: Playwright launches the real Electron app (see e2e/).
// Run with `npm run test:e2e`. Unit tests stay on `npm test`.
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './e2e',
  timeout: 60000,
  expect: { timeout: 10000 },
  fullyParallel: false,
  workers: 1, // one app window at a time; each test uses its own temporary profile
  retries: process.env.CI ? 2 : 0,
  reporter: [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]],
  outputDir: 'test-results',
});
