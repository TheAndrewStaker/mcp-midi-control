/**
 * verify-console-design.ts — the Rig Console design-system gate (Phase A,
 * docs/design/RIG-CONSOLE-WORKPLAN.md; rules in RIG-CONSOLE-MENU-LANGUAGE.md).
 *
 * Makes "looks right" a checkable property, the way this repo gates wire
 * formats: one token source of truth (theme.ts) + mechanical conformance.
 *
 *   1. HEX SANCTION: every hex literal in the emitted stylesheet must be a
 *      value the active theme declares. Ad-hoc colors cannot ship.
 *   2. CONTRAST: WCAG 2.x relative-luminance ratios computed for every
 *      declared pair, BOTH modes. Legibility cannot regress silently.
 *   3. NO STATUS DOTS (owner rule, 2026-08-23): no border-radius:50% in
 *      the stylesheet, no `.dot`-style classes, no circle status glyphs in
 *      the renderer sources. Status is chips/edges/typography, never a dot.
 *   4. TYPE LADDER: every font-size in the stylesheet is on the declared
 *      scale (menu-language rule 25 fixes the hierarchy's anchor).
 *
 * Pure static: no MIDI, no network, no DOM. Run: npm run verify-console-design
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ACTIVE_THEME, CONTRAST_RULES, TYPE_SCALE_PX, sanctionedHex, tokensCss,
} from '../packages/rig-console-render/src/theme.js';
import { CONSOLE_CSS } from '../packages/rig-console-render/src/page.js';

let failed = 0;
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) console.log(`  OK    ${label}`);
  else { failed++; console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
}

// ── 1. hex sanction ─────────────────────────────────────────────────
{
  const sanctioned = sanctionedHex();
  const found = CONSOLE_CSS.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
  const offenders = [...new Set(found.map((h) => h.toLowerCase()))]
    .filter((h) => !sanctioned.has(h));
  check(
    `stylesheet hex literals are all theme-sanctioned (${sanctioned.size} sanctioned, ${found.length} uses)`,
    offenders.length === 0,
    `unsanctioned: ${offenders.slice(0, 8).join(', ')} — add to the theme or resolve through a token`,
  );
}

// ── 2. computed contrast ────────────────────────────────────────────
function relLum(hex: string): number {
  const h = hex.replace('#', '');
  const n = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(n.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}
function ratio(fg: string, bg: string): number {
  const [a, b] = [relLum(fg), relLum(bg)].sort((x, y) => y - x);
  return (a! + 0.05) / (b! + 0.05);
}
for (const mode of ['dark', 'light'] as const) {
  for (const rule of CONTRAST_RULES) {
    const r = ratio(ACTIVE_THEME[mode][rule.fg], ACTIVE_THEME[mode][rule.bg]);
    check(
      `${mode}: ${rule.fg} on ${rule.bg} ≥ ${rule.min} (got ${r.toFixed(2)})`,
      r >= rule.min,
      'retune the token value; do not lower the declared minimum',
    );
  }
}

// ── 3. no status dots ───────────────────────────────────────────────
{
  check('stylesheet has no border-radius:50% (status dots are banned)',
    !/border-radius:\s*50%/.test(CONSOLE_CSS));
  check('stylesheet declares no dot/led/lamp/pip classes',
    !/\.(dot|led|lamp|pip)\b/.test(CONSOLE_CSS));
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const srcDir = path.resolve(HERE, '../packages/rig-console-render/src');
  for (const f of ['page.ts', 'diagram.ts']) {
    const src = readFileSync(path.join(srcDir, f), 'utf8');
    check(`${f} emits no dot-class markup`, !/class="(dot|led|lamp|pip)"/.test(src));
    check(`${f} emits no circle status glyphs`,
      !/<circle class="(heard|unheard|dot|status)/.test(src));
  }
}

// ── 4. type ladder ──────────────────────────────────────────────────
{
  const sizes = new Set<number>();
  for (const m of CONSOLE_CSS.matchAll(/font(?:-size)?:\s*([\d.]+)px/g)) sizes.add(Number(m[1]));
  const off = [...sizes].filter((s) => !TYPE_SCALE_PX.includes(s)).sort((a, b) => a - b);
  check(
    `every stylesheet font-size is on the declared ladder (${sizes.size} distinct sizes)`,
    off.length === 0,
    `off-ladder: ${off.join(', ')} — use a ladder size or extend TYPE_SCALE_PX deliberately`,
  );
}

// ── 5. tokens block is the stylesheet's opening statement ───────────
check('stylesheet begins with the emitted token blocks',
  CONSOLE_CSS.trimStart().startsWith(tokensCss().slice(0, 40)),
  'page.ts must interpolate tokensCss() first — nothing may precede the contract');

console.log('');
if (failed > 0) {
  console.error(`x verify-console-design: ${failed} check(s) FAILED.`);
  process.exit(1);
}
console.log('OK verify-console-design: tokens, contrast, no-dots, and the type ladder all hold.');
