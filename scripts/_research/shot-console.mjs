import { chromium } from '@playwright/test';
const flow = process.argv[2], out = process.argv[3];
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
await p.goto('file:///C:/dev/mcp-midi-tools/docs/_private/rig/rig-console.html');
if (flow === 'midi') { await p.locator('.flowtoggle button[data-flow="midi"]').click(); await p.waitForTimeout(500); }
await p.waitForTimeout(500);
await p.screenshot({ path: out });
await b.close();
