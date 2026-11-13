/**
 * screenshots.spec.ts — the visual-regression baseline for the approved look
 * (BK-RC-PHASE-D): four full-page shots covering each deck and both map flows.
 *
 * PLATFORM-GATED ON PURPOSE. Font rasterization and antialiasing differ per
 * OS, so a pixel baseline is only meaningful on the platform it was captured
 * on. The baseline is maintained on win32 (the machine where design review
 * happens); elsewhere these specs skip and the flow specs carry the gate.
 * After a DELIBERATE design change, re-baseline with
 * `npx playwright test --update-snapshots` and commit the new PNGs.
 */
import { expect, test } from '@playwright/test';
import { pathToFileURL } from 'node:url';

import { FIXTURE_HTML } from './fixture.js';

test.skip(process.platform !== 'win32' || process.env.CI !== undefined,
  'pixel baseline is maintained on the design-review machine (win32, local) only: another machine\'s '
  + 'renderer antialiases differently and would fail on noise; the flow specs carry the gate everywhere else');

const url = pathToFileURL(FIXTURE_HTML).href;

test.beforeEach(async ({ page }) => {
  await page.goto(url);
  await page.evaluate(() => (document as Document & { fonts: FontFaceSet }).fonts.ready);
});

test('rig deck, audio flow', async ({ page }) => {
  await expect(page).toHaveScreenshot('rig-audio.png');
});

test('rig deck, midi flow with a device inspected', async ({ page }) => {
  await page.locator('.flowtoggle button[data-flow="midi"]').click();
  await page.locator('g.rcnode[data-device="circuit"]').click();
  await expect(page).toHaveScreenshot('rig-midi-inspect.png');
});

test('songs deck with a song selected', async ({ page }) => {
  await page.keyboard.press(']');
  await page.locator('tr.song', { hasText: 'Alpha' }).click();
  await expect(page).toHaveScreenshot('songs-selected.png');
});

test('packs deck with a pad inspected', async ({ page }) => {
  await page.keyboard.press('[');
  await page.locator('#packs .slot[data-slot="1:1"]').click();
  await expect(page).toHaveScreenshot('packs-inspect.png');
});
