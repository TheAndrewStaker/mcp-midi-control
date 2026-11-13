/**
 * Playwright config for the Rig Console flow gate (BK-RC-PHASE-D).
 *
 * Scope: tests/console-e2e only. The suite drives the CONSOLE'S OWN CODE over
 * a synthetic fixture render (tests/console-e2e/fixture.ts) — no maintainer
 * data, no hardware, no network — so it runs anywhere the repo builds.
 * Prereqs: `npm run build` (the fixture imports built workspace packages) and
 * a chromium (`npx playwright install chromium`, one-time).
 *
 * Determinism: fixed viewport, reduced motion (kills the map's glide
 * transitions), animations disabled in screenshots. The screenshot baseline
 * is captured per-platform ({platform} in the snapshot path); the pixel specs
 * run only where a baseline is maintained (win32, where design review
 * happens) — the FLOW specs run everywhere.
 */
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/console-e2e',
  outputDir: 'tests/console-e2e/.results',
  globalSetup: './tests/console-e2e/global-setup.ts',
  fullyParallel: true,
  forbidOnly: true,
  retries: 0,
  reporter: [['list']],
  snapshotPathTemplate: '{testDir}/__screenshots__/{arg}-{platform}{ext}',
  expect: {
    toHaveScreenshot: { animations: 'disabled', caret: 'hide' },
  },
  use: {
    browserName: 'chromium',
    viewport: { width: 1440, height: 900 },
    contextOptions: { reducedMotion: 'reduce' },
  },
});
