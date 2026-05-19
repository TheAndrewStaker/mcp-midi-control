/**
 * BK-066 Phase 2 goldens.
 *
 * `resolveEnumAlias(port, block, paramName, enumValue)` returns the
 * target port's canonical display string when the input is the same
 * conceptual model under another device's spelling. Phase 2 is the
 * concept-key cross-device table that closes the gap Phase 1's edit-
 * distance matcher can't reach (`"USA IIC+"` -> `"USA MK IIC+"` is
 * distance 4 after normalization, beyond the fuzzy tier).
 *
 * Run: npx tsx scripts/verify-cross-device-enums.ts
 *
 * Source of truth: docs/_private/bk066-phase2-enum-mapping-research.md.
 * Wired into npm test for regression coverage alongside Phase 1.
 */

import {
  resolveEnumAlias,
  type ResolvedEnumAlias,
} from '@mcp-midi-control/core/protocol-generic/cross-device-enums.js';

interface EnumAliasCase {
  port: string;
  block: string;
  paramName: string;
  input: string;
  expected: ResolvedEnumAlias;
  desc: string;
}

const cases: EnumAliasCase[] = [
  // ── Cross-device substitutions (the originating divergence) ──────
  {
    port: 'am4',
    block: 'amp',
    paramName: 'type',
    input: 'USA IIC+',
    expected: { canonical: 'USA MK IIC+', aliasUsed: 'USA IIC+', conceptKey: 'mesa-mark-iic-plus' },
    desc: 'AM4 amp.type: II "USA IIC+" -> AM4 "USA MK IIC+"',
  },
  {
    port: 'axe-fx-ii',
    block: 'amp',
    paramName: 'type',
    input: 'USA MK IIC+',
    expected: { canonical: 'USA IIC+', aliasUsed: 'USA MK IIC+', conceptKey: 'mesa-mark-iic-plus' },
    desc: 'II amp.type: AM4 "USA MK IIC+" -> II "USA IIC+"',
  },

  // ── Double-plus character (Mark IIC++) ────────────────────────────
  {
    port: 'axe-fx-ii',
    block: 'amp',
    paramName: 'type',
    input: 'USA MK IIC++',
    expected: { canonical: 'USA IIC++', aliasUsed: 'USA MK IIC++', conceptKey: 'mesa-mark-iic-plus-plus' },
    desc: 'II amp.type: AM4 "USA MK IIC++" -> II "USA IIC++"',
  },

  // ── Abbreviation patterns (NRML / NRM / VIB / RHY) ───────────────
  {
    port: 'axe-fx-ii',
    block: 'amp',
    paramName: 'type',
    input: 'Plexi 100W Normal',
    expected: { canonical: 'PLEXI 100W NRML', aliasUsed: 'Plexi 100W Normal', conceptKey: 'marshall-plexi-100w-normal' },
    desc: 'II amp.type: AM4 "Plexi 100W Normal" -> II "PLEXI 100W NRML"',
  },
  {
    port: 'axe-fx-ii',
    block: 'amp',
    paramName: 'type',
    input: 'Deluxe Verb Vibrato',
    expected: { canonical: 'DELUXE VERB VIB', aliasUsed: 'Deluxe Verb Vibrato', conceptKey: 'fender-deluxe-verb-vibrato' },
    desc: 'II amp.type: AM4 "Deluxe Verb Vibrato" -> II "DELUXE VERB VIB"',
  },
  {
    port: 'am4',
    block: 'amp',
    paramName: 'type',
    input: 'DIZZY V4 SLVR 3',
    expected: { canonical: 'Dizzy V4 Silver 3', aliasUsed: 'DIZZY V4 SLVR 3', conceptKey: 'diezel-vh4-silver-3' },
    desc: 'AM4 amp.type: II "DIZZY V4 SLVR 3" -> AM4 "Dizzy V4 Silver 3" (non-obvious tokenization)',
  },

  // ── Drive: DIST / Distortion suffix split ─────────────────────────
  {
    port: 'am4',
    block: 'drive',
    paramName: 'type',
    input: 'RAT DIST',
    expected: { canonical: 'Rat Distortion', aliasUsed: 'RAT DIST', conceptKey: 'proco-rat' },
    desc: 'AM4 drive.type: II "RAT DIST" -> AM4 "Rat Distortion"',
  },
  {
    port: 'axe-fx-ii',
    block: 'drive',
    paramName: 'type',
    input: 'M-Zone Distortion',
    expected: { canonical: 'M-ZONE DIST', aliasUsed: 'M-Zone Distortion', conceptKey: 'boss-mt2-metal-zone' },
    desc: 'II drive.type: AM4 "M-Zone Distortion" -> II "M-ZONE DIST"',
  },

  // ── Reverb: comma-swap algorithm class ───────────────────────────
  {
    port: 'axe-fx-ii',
    block: 'reverb',
    paramName: 'type',
    input: 'Room, Large',
    expected: { canonical: 'LARGE ROOM', aliasUsed: 'Room, Large', conceptKey: 'room-large' },
    desc: 'II reverb.type: AM4 "Room, Large" -> II "LARGE ROOM"',
  },
  {
    port: 'am4',
    block: 'reverb',
    paramName: 'type',
    input: 'LONDON PLATE',
    expected: { canonical: 'Plate, London', aliasUsed: 'LONDON PLATE', conceptKey: 'plate-london-emt140' },
    desc: 'AM4 reverb.type: II "LONDON PLATE" -> AM4 "Plate, London"',
  },
  {
    port: 'am4',
    block: 'reverb',
    paramName: 'type',
    input: 'CONCERT HALL',
    expected: { canonical: 'Hall, Concert', aliasUsed: 'CONCERT HALL', conceptKey: 'hall-concert' },
    desc: 'AM4 reverb.type: II "CONCERT HALL" -> AM4 "Hall, Concert"',
  },

  // ── Same-port no-op (canonical value passes through unchanged) ───
  {
    port: 'am4',
    block: 'amp',
    paramName: 'type',
    input: 'USA MK IIC+',
    expected: { canonical: 'USA MK IIC+' },
    desc: 'AM4 amp.type: AM4 native "USA MK IIC+" -> unchanged, no aliasUsed',
  },
  {
    port: 'axe-fx-ii',
    block: 'reverb',
    paramName: 'type',
    input: 'LARGE ROOM',
    expected: { canonical: 'LARGE ROOM' },
    desc: 'II reverb.type: II native "LARGE ROOM" -> unchanged',
  },

  // ── Case-insensitive lookup on input ──────────────────────────────
  {
    port: 'am4',
    block: 'amp',
    paramName: 'type',
    input: 'usa iic+',
    expected: { canonical: 'USA MK IIC+', aliasUsed: 'usa iic+', conceptKey: 'mesa-mark-iic-plus' },
    desc: 'AM4 amp.type: case-insensitive II "usa iic+" -> AM4 "USA MK IIC+"',
  },

  // ── Negative cases ────────────────────────────────────────────────
  {
    port: 'am4',
    block: 'amp',
    paramName: 'type',
    input: "WIZARD'S WAND",
    expected: { canonical: "WIZARD'S WAND" },
    desc: 'AM4 amp.type: unrecognized string -> unchanged, no aliasUsed, no conceptKey',
  },
  {
    port: 'hydrasynth',
    block: 'amp',
    paramName: 'type',
    input: 'USA IIC+',
    expected: { canonical: 'USA IIC+' },
    desc: 'unknown port: hydrasynth amp.type "USA IIC+" -> unchanged',
  },
  {
    port: 'am4',
    block: 'unknown_block',
    paramName: 'type',
    input: 'USA IIC+',
    expected: { canonical: 'USA IIC+' },
    desc: 'unknown block: AM4 unknown_block.type "USA IIC+" -> unchanged',
  },
  {
    port: 'axe-fx-iii',
    block: 'amp',
    paramName: 'type',
    input: 'USA IIC+',
    expected: { canonical: 'USA IIC+' },
    desc: 'III target with null axeFxIII column -> input passes through',
  },
];

function deepEqual(a: ResolvedEnumAlias, b: ResolvedEnumAlias): boolean {
  return (
    a.canonical === b.canonical &&
    a.aliasUsed === b.aliasUsed &&
    a.conceptKey === b.conceptKey
  );
}

let passed = 0;
let failed = 0;

console.log('── BK-066 Phase 2 resolveEnumAlias goldens ──');
for (const c of cases) {
  const got = resolveEnumAlias(c.port, c.block, c.paramName, c.input);
  const ok = deepEqual(got, c.expected);
  const mark = ok ? '✓' : '✗';
  console.log(`${mark} ${c.desc}`);
  if (!ok) {
    console.log(`    port=${c.port} block=${c.block} param=${c.paramName} input=${JSON.stringify(c.input)}`);
    console.log(`    expected: ${JSON.stringify(c.expected)}`);
    console.log(`    got:      ${JSON.stringify(got)}`);
    failed++;
  } else {
    passed++;
  }
}

console.log(`\n${passed}/${cases.length} cases pass.`);
if (failed > 0) process.exit(1);
