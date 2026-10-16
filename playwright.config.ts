import { defineConfig } from '@playwright/test';
import { E2E_BASE_URL, E2E_PORT } from './e2e/constants.ts';

/**
 * S18.13 — enrolment, all three sign-in paths and the landing view, driven
 * end to end in a real browser against a real repository. `webServer` starts
 * the actual `src/server.ts` (via `e2e/run-server.ts`, which seeds a fresh
 * volume and credential mount first) rather than anything Playwright itself
 * fakes — the criteria are checked against that process, not a request-level
 * stand-in.
 */
export default defineConfig({
  testDir: './e2e',
  testMatch: '*.spec.ts',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: E2E_BASE_URL,
    // CI provides the runner's own Chrome (node-ci.yml's `browser: true`) in
    // place of `npx playwright install --with-deps`, whose apt step could
    // stall for the whole job. Unset locally, so Playwright's bundled
    // Chromium is used as before.
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } }
      : {}),
  },
  webServer: {
    command: 'node --disable-warning=ExperimentalWarning --disable-warning=MODULE_TYPELESS_PACKAGE_JSON e2e/run-server.ts',
    port: E2E_PORT,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
