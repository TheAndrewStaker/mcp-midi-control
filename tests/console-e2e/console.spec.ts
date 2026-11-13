/**
 * console.spec.ts — Playwright coverage of the RIG-CONSOLE-VISUAL-SIGNOFF.md
 * checkable flows (BK-RC-PHASE-D), driven against the synthetic fixture page
 * (see fixture.ts for what the fixture deliberately contains).
 *
 * Fixture topology facts these specs assert on (from openrig's LOOPER_HUB_RIG):
 *   AUDIO flow: cab (front of house) above rc505 (the hub) above am4 (feeder);
 *     circuit/spdsx/thru hidden; 2 focused audio wires; the am4 scene-CC cable
 *     runs between two audio-placed boxes, so it is the one GHOST.
 *   MIDI flow: rc505 + circuit (master band), thru (infra), spdsx (voice);
 *     am4 + cab hidden; 3 focused wires; no audio edge joins two placed boxes,
 *     so no ghosts.
 *
 * Items that stay MANUAL on the signoff checklist (not coverable here):
 * the served shell's edit_rig auto-refresh (host behavior, not the page), and
 * every judgment call ("is it followable", "fast enough mid-session").
 */
import { expect, test, type Page } from '@playwright/test';
import { pathToFileURL } from 'node:url';

import { FIXTURE_HTML } from './fixture.js';

const url = pathToFileURL(FIXTURE_HTML).href;

test.beforeEach(async ({ page }) => {
  await page.goto(url);
});

/** The world <g> that pan/zoom transforms (first g child of svg.rcmap). */
const worldTransform = (page: Page): Promise<string> =>
  page.evaluate(() => document.querySelector('svg.rcmap > g:not(defs)')?.getAttribute('transform') ?? '');

/** translate-y of a map node, read from its placement transform. */
const nodeY = async (page: Page, id: string): Promise<number> => {
  const t = await page.locator(`g.rcnode[data-device="${id}"]`).getAttribute('transform');
  const m = t?.match(/translate\(\S+ (\S+)\)/);
  expect(m, `node ${id} has a placement transform`).toBeTruthy();
  return Number(m![1]);
};

// ── shell + theme ───────────────────────────────────────────────────────────

test('the real faces load (RigUI / RigMono, not a fallback font)', async ({ page }) => {
  await page.evaluate(() => (document as Document & { fonts: FontFaceSet }).fonts.ready);
  expect(await page.evaluate(() => document.fonts.check('13px RigUI'))).toBe(true);
  expect(await page.evaluate(() => document.fonts.check('13px RigMono'))).toBe(true);
});

test('[ and ] cycle the decks; clicking tabs works; the location line follows', async ({ page }) => {
  const pageAttr = () => page.evaluate(() => document.documentElement.getAttribute('data-rc-page'));
  expect(await pageAttr()).toBe('rig');
  await page.keyboard.press(']');
  expect(await pageAttr()).toBe('set');
  await expect(page.locator('#rc-loc')).toHaveText('Songs');
  await page.keyboard.press(']');
  expect(await pageAttr()).toBe('card');
  await expect(page.locator('#rc-loc')).toHaveText('Packs');
  await page.keyboard.press(']'); // wraps
  expect(await pageAttr()).toBe('rig');
  await page.keyboard.press('[');
  expect(await pageAttr()).toBe('card');
  await page.locator('.tab[data-deck="set"]').click();
  expect(await pageAttr()).toBe('set');
  await expect(page.locator('.tab[data-deck="set"]')).toHaveAttribute('aria-selected', 'true');
});

test('no status dots; no Show Everything button; status rides the bottom-left corner', async ({ page }) => {
  expect(await page.locator('.dot, .led').count()).toBe(0);
  expect(await page.locator('#reset').count()).toBe(0); // removed 2026-08-24 (Esc clears; map keeps one selection)
  // source status is the bottom-left amber system corner, not top chips
  expect(await page.locator('.shellbar .chip').count()).toBe(0);
  const sys = page.locator('#rc-sysinfo');
  await expect(sys).toBeVisible();
  await expect(sys.locator('.si')).toHaveCount(3);
  await expect(sys).toContainText('Rig manifest');
  const box = (await sys.boundingBox())!;
  const vp = page.viewportSize()!;
  expect(box.x).toBeLessThan(vp.width / 4);
  expect(box.y + box.height).toBeGreaterThan(vp.height * 0.6);
  // the Songs deck's bottom-left belongs to the Voices panel; status yields
  await page.keyboard.press(']');
  await expect(sys).toBeHidden();
});

test('print: chrome hidden, fallback diagram + all decks present, paper background', async ({ page }) => {
  await page.emulateMedia({ media: 'print' });
  const display = (sel: string) =>
    page.evaluate((s) => {
      const el = document.querySelector(s);
      return el === null ? 'MISSING' : getComputedStyle(el).display;
    }, sel);
  expect(await display('.shellbar .tabs')).toBe('none');
  expect(await display('.chipbar')).toBe('none');
  expect(await display('.mapwrap')).toBe('none');
  expect(await display('#deck-rig .riggrid.map-fallback')).toBe('grid');
  // every deck renders on paper, not just the active one
  expect(await display('#deck-set')).not.toBe('none');
  expect(await display('#deck-card')).not.toBe('none');
});

// ── the living map ──────────────────────────────────────────────────────────

test('map renders full-bleed; the fallback diagram+list leave the screen view', async ({ page }) => {
  await expect(page.locator('.mapwrap.on svg.rcmap')).toBeVisible();
  const fb = page.locator('#deck-rig .riggrid');
  await expect(fb).toHaveClass(/map-fallback/);
  await expect(fb).toBeHidden();
});

test('the map fills the right half on fixed column tracks with a hub spine', async ({ page }) => {
  // mgsv orientation (owner, 2026-08-24 rounds 2-3): subject fills the
  // right half tall; inspect top-left, system status bottom-left. Modules
  // are uniform and snap to column tracks; a dim spine runs through the
  // hub's track.
  const svg = (await page.locator('svg.rcmap').boundingBox())!;
  const nodes = (await page.evaluate(() => {
    const g = document.querySelectorAll('svg.rcmap g.rcnode');
    let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
    const widths = new Set<string>(), xs = new Set<string>();
    for (const el of g) {
      if ((el as SVGGElement).style.display === 'none') continue;
      const r = el.getBoundingClientRect();
      minX = Math.min(minX, r.left); maxX = Math.max(maxX, r.right);
      minY = Math.min(minY, r.top); maxY = Math.max(maxY, r.bottom);
      widths.add(el.querySelector('rect')!.getAttribute('width')!);
      const m = el.getAttribute('transform')!.match(/translate\((\S+) /);
      xs.add(m![1]!);
    }
    return { cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, left: minX, widths: [...widths], tracks: xs.size };
  }));
  expect(nodes.cx).toBeGreaterThan(svg.x + svg.width / 2);          // right half
  expect(nodes.left).toBeGreaterThan(svg.x + svg.width * 0.3);      // clear of the inspect quadrants
  expect(nodes.cy).toBeGreaterThan(svg.y + svg.height * 0.3);       // vertically centred in the tall region,
  expect(nodes.cy).toBeLessThan(svg.y + svg.height * 0.7);          // not pinned to one quadrant
  expect(nodes.widths).toHaveLength(1);                             // uniform modules
  expect(nodes.tracks).toBeLessThanOrEqual(4);                      // column-track snapping
  // spine segments run BETWEEN the boxes on the spine track, never through
  // one (2026-08-27: a continuous line showed inside translucent boxes)
  expect(await page.locator('svg.rcmap line.rcspine').count()).toBeGreaterThanOrEqual(1);
  const spineClear = await page.evaluate(() => {
    const boxes = [...document.querySelectorAll('svg.rcmap g.rcnode')]
      .filter((g) => (g as SVGGElement).style.display !== 'none')
      .map((g) => g.getBoundingClientRect());
    return [...document.querySelectorAll('svg.rcmap line.rcspine')].every((l) => {
      const r = l.getBoundingClientRect();
      return boxes.every((b) => r.bottom <= b.top + 1 || r.top >= b.bottom - 1
        || r.left > b.right || r.right < b.left);
    });
  });
  expect(spineClear).toBe(true);
});

test('one item is always selected: the hub inspects on load', async ({ page }) => {
  const inspect = page.locator('#rc-inspect');
  await expect(inspect).toHaveClass(/on/);
  await expect(inspect.locator('.ph')).toHaveText('RC-505mk2'); // the audio flow's primary (the hub)
  await expect(page.locator('g.rcnode[data-device="rc505"]')).toHaveClass(/sel/);
  // the selection survives a flow switch (rc505 exists in both flows)
  await page.locator('.flowtoggle button[data-flow="midi"]').click();
  await expect(inspect).toHaveClass(/on/);
  await expect(inspect.locator('.ph')).toHaveText('RC-505mk2');
});

test('AUDIO is the default flow: reference-tree orientation, absentees hidden, one ghost', async ({ page }) => {
  await expect(page.locator('.flowtoggle button[data-flow="audio"]')).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => document.documentElement.getAttribute('data-rc-flow'))).toBe('audio');
  // front of house above the root, feeders below by hop
  const cab = await nodeY(page, 'cab');
  const hub = await nodeY(page, 'rc505');
  const am4 = await nodeY(page, 'am4');
  expect(cab).toBeLessThan(hub);
  expect(hub).toBeLessThan(am4);
  // devices with no audio edge are absent from the view, not drawn anyway
  for (const id of ['circuit', 'spdsx', 'thru']) {
    await expect(page.locator(`g.rcnode[data-device="${id}"]`)).toBeHidden();
  }
  expect(await page.locator('path.rcw.audio:not(.glow):not(.hit):not(.ghost)').count()).toBe(2);
  expect(await page.locator('path.rcw.ghost').count()).toBe(1); // the scene-CC cable, ghosted under audio
});

test('toggling to MIDI flow relays out the band layout and re-homes the devices', async ({ page }) => {
  await page.locator('.flowtoggle button[data-flow="midi"]').click();
  await expect(page.locator('.flowtoggle button[data-flow="midi"]')).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => document.documentElement.getAttribute('data-rc-flow'))).toBe('midi');
  for (const id of ['rc505', 'circuit', 'thru', 'spdsx']) {
    await expect(page.locator(`g.rcnode[data-device="${id}"]`)).toBeVisible();
  }
  for (const id of ['am4', 'cab']) {
    await expect(page.locator(`g.rcnode[data-device="${id}"]`)).toBeHidden();
  }
  // master band above the voice band
  expect(await nodeY(page, 'rc505')).toBeLessThan(await nodeY(page, 'spdsx'));
  expect(await page.locator('path.rcw.midi:not(.glow):not(.hit):not(.ghost)').count()).toBe(3);
});

test('wire grammar: every drawn wire is line+arc only (no cubic or quadratic beziers)', async ({ page }) => {
  for (const flow of ['audio', 'midi']) {
    await page.locator(`.flowtoggle button[data-flow="${flow}"]`).click();
    const ds = await page.$$eval('path.rcw:not(.hit)', (els) => els.map((el) => el.getAttribute('d') ?? ''));
    expect(ds.length).toBeGreaterThan(0);
    for (const d of ds) {
      expect(d).not.toMatch(/[CQSTcqst]/);
      expect(d).toMatch(/^M/);
    }
    // 5px square terminal pads on every focused wire end
    const focused = await page.locator('path.rcw:not(.glow):not(.hit):not(.ghost)').count();
    expect(await page.locator('rect.rcpad').count()).toBe(2 * focused);
  }
});

test('drag pans and wheel zooms the map', async ({ page }) => {
  const svg = page.locator('svg.rcmap');
  const box = (await svg.boundingBox())!;
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  const before = await worldTransform(page);
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 80, cy + 50);
  await page.mouse.up();
  const panned = await worldTransform(page);
  expect(panned).not.toBe(before);
  await page.mouse.move(cx, cy);
  await page.mouse.wheel(0, -240);
  const zoomed = await worldTransform(page);
  expect(zoomed).not.toBe(panned);
});

test('click a device: the floating inspect fills with its detail; nodes mark selection', async ({ page }) => {
  await page.locator('g.rcnode[data-device="rc505"]').click();
  const inspect = page.locator('#rc-inspect');
  await expect(inspect).toHaveClass(/on/);
  await expect(inspect.locator('.ph')).toHaveText('RC-505mk2');
  await expect(inspect.locator('.conn').first()).toBeVisible(); // its connection list projects in
  await expect(page.locator('g.rcnode[data-device="rc505"]')).toHaveClass(/sel/);
});

test('click a cable: its endpoints, kind and label fill the inspect', async ({ page }) => {
  await page.locator('path.rcw.hit[data-edge="am4-audio"]').dispatchEvent('pointerdown', { bubbles: true });
  await page.locator('svg.rcmap').dispatchEvent('pointerup', { bubbles: true });
  const inspect = page.locator('#rc-inspect');
  await expect(inspect).toHaveClass(/on/);
  await expect(inspect.locator('.ph')).toContainText('Fractal AM4');
  await expect(inspect.locator('.ph')).toContainText('RC-505mk2');
  await expect(inspect.locator('.tag.audio')).toBeVisible();
});

test('the sequencer inspect links to the card mapping and jumps to Packs', async ({ page }) => {
  await page.locator('.flowtoggle button[data-flow="midi"]').click();
  await page.locator('g.rcnode[data-device="circuit"]').click();
  const link = page.locator('#rc-inspect .maplink');
  await expect(link).toHaveText(/View card mapping/);
  await link.click();
  expect(await page.evaluate(() => document.documentElement.getAttribute('data-rc-page'))).toBe('card');
});

// ── songs + packs (the dogfood loop) ────────────────────────────────────────

test('songs table groups On the board / Staging; a card-less setlist song stages', async ({ page }) => {
  await page.keyboard.press(']');
  const groups = page.locator('tr.grp td');
  await expect(groups.nth(0)).toContainText('On the board · 2');
  await expect(groups.nth(1)).toContainText('Staging · 1');
  // exactly once: the unplaced list used to render each card-less song a
  // second time (the double-draw this fixture caught)
  expect(await page.locator('tr.song', { hasText: 'Charlie' }).count()).toBe(1);
  await expect(page.locator('tr.song.staged-empty')).toContainText('Charlie');
  expect(await page.locator('.tasks .task.open', { hasText: 'Charlie' }).count()).toBe(1);
});

test('selecting a song lights its project run on the Packs grids and fills its say-line', async ({ page }) => {
  await page.keyboard.press(']');
  await page.locator('tr.song', { hasText: 'Alpha' }).click();
  await expect(page.locator('#rc-desc')).toContainText('Alpha: 4 projects, Pack 1 projects 1-4, 120 BPM');
  await expect(page.locator('#packs')).toHaveClass(/filtered/);
  expect(await page.locator('#packs .slot.hit').count()).toBe(4);
  // the resting pads recede but stay READABLE (owner, 2026-08-24: the old
  // .18 spotlight blacked the card out); the hit run stays full-strength
  const opacities = await page.evaluate(() => ({
    resting: Number(getComputedStyle(document.querySelector('#packs .slot.used:not(.hit)')!).opacity),
    hit: Number(getComputedStyle(document.querySelector('#packs .slot.hit')!).opacity),
  }));
  expect(opacities.resting).toBeGreaterThanOrEqual(0.4);
  expect(opacities.resting).toBeLessThan(0.8);
  expect(opacities.hit).toBe(1);
  await page.keyboard.press('Escape');
  await expect(page.locator('#packs')).not.toHaveClass(/filtered/);
});

test('the gold Voices panel: idle coverage line, per-song claims with status tags, owed rows', async ({ page }) => {
  await page.keyboard.press(']');
  const idle = page.locator('#rc-voices tbody.voi.idle');
  await expect(idle).toHaveClass(/on/);
  await expect(idle).toContainText('1 of 3 songs have voices filed');
  await expect(idle).toContainText('Filed but unknown to the setlist and the capture: Delta');
  await page.locator('tr.song', { hasText: 'Alpha' }).click();
  const alpha = page.locator('#rc-voices tbody.voi[data-song="alpha"]');
  await expect(alpha).toHaveClass(/on/);
  await expect(idle).not.toHaveClass(/on/);
  await expect(alpha.locator('.tag.ok')).toHaveText('confirmed');
  await expect(alpha.locator('.tag.warn')).toHaveText('proposed');
  await expect(alpha.locator('.tag.bad')).toHaveText('owed'); // the slot-less BK-VOICES-FILING shape
  await expect(alpha).toContainText('Warm Sub');
  // a song with nothing filed says so instead of hiding
  await page.locator('tr.song', { hasText: 'Bravo' }).click();
  await expect(page.locator('#rc-voices tbody.voi[data-song="bravo"]')).toContainText('No voices filed for Bravo yet');
});

test('packs: pad detail in its own amber column; grids never occluded; Esc closes', async ({ page }) => {
  await page.keyboard.press('[');
  const pad = page.locator('#packs .slot[data-slot="1:1"]');
  await pad.click();
  const insp = page.locator('#rc-padinspect');
  await expect(insp).toHaveClass(/on/);
  await expect(insp.locator('.ph')).toHaveText('P1 · 1');
  await expect(insp.locator('h3')).toHaveText('Alpha 1 Intro');
  // labeled amber ledger rows (the Voices .rew grammar), not prose lines
  await expect(insp.locator('.rew td.k').first()).toHaveText('Song');
  await expect(insp).toContainText('120 BPM');
  // the detail owns reserved space: the grids sit clear of it, so EVERY pad
  // stays clickable while it is open (owner, 2026-08-24: a floating panel
  // over the grids stole their clicks)
  const inspBox = (await insp.boundingBox())!;
  const gridBox = (await page.locator('#packs').boundingBox())!;
  expect(gridBox.x).toBeGreaterThanOrEqual(inspBox.x + inspBox.width);
  await page.locator('#packs .slot[data-slot="1:2"]').click();
  await expect(insp.locator('h3')).toHaveText('Alpha 2 Verse');
  await page.keyboard.press('Escape');
  await expect(insp).not.toHaveClass(/on/);
  await expect(page.locator('#packs .slot[data-slot="1:4"]')).toHaveClass(/flag/);
  await expect(page.locator('#deck-card .runs').first()).toContainText('room for a whole song');
});
