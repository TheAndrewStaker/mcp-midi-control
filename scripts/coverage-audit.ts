/**
 * Coverage audit — auto-snapshot of "what's actually decoded vs shipped vs tested."
 *
 * Reads three sources of truth and joins them:
 *
 *   1. Ghidra catalog (`samples/captured/decoded/ghidra-am4-paramnames.json`)
 *      — every paramId Fractal's own engineers use, keyed by family.
 *      Gracefully skipped if not present locally (it's gitignored).
 *   2. `packages/am4/src/params.ts` — what's actually addressable from MCP.
 *   3. `scripts/verify-msg.ts` — what's wire-tested with byte-exact goldens.
 *
 * Outputs a stdout report with per-family coverage stats and totals. Runs
 * in preflight so a session-start glance answers "where are we?" without
 * scrolling STATE.md handoff lists that go stale.
 *
 * Not a verification script — never fails, just informs.
 *
 *   npx tsx scripts/coverage-audit.ts
 *   npm run coverage-audit  (alias)
 */

import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

// AM4 params + blockTypes now live in the `fractal-midi` npm package.
// Resolve via the package's subpath exports so the path works regardless
// of where the consumer cloned mcp-midi-control. We read the compiled
// .js (which preserves the object-literal entry shape the regex below
// matches) rather than the .ts source.
const require = createRequire(import.meta.url);
const FRACTAL_MIDI_AM4_DIR = dirname(require.resolve('fractal-midi/am4'));
const FRACTAL_MIDI_AXEFX2_DIR = dirname(require.resolve('fractal-midi/axe-fx-ii'));
const FRACTAL_MIDI_AXEFX3_DIR = dirname(require.resolve('fractal-midi/axe-fx-iii'));

const PARAMS_TS = join(FRACTAL_MIDI_AM4_DIR, 'params.js');
const BLOCK_TYPES_TS = join(FRACTAL_MIDI_AM4_DIR, 'blockTypes.js');
const VERIFY_MSG_TS = 'scripts/verify-msg.ts';
const GHIDRA_AM4 = 'samples/captured/decoded/ghidra-am4-paramnames.json';

// Block name → catalog family. Multiple blocks can share a family (amp +
// drive both pull from DISTORT). Mirrors generate-am4-params-from-catalog.ts.
const BLOCK_TO_FAMILY: Record<string, string> = {
  amp: 'DISTORT',
  drive: 'DISTORT',
  reverb: 'REVERB',
  delay: 'DELAY',
  chorus: 'CHORUS',
  flanger: 'FLANGER',
  phaser: 'PHASER',
  rotary: 'ROTARY',
  tremolo: 'TREMOLO',
  wah: 'WAH',
  filter: 'FILTER',
  compressor: 'COMP',
  geq: 'GEQ',
  peq: 'PEQ',
  gate: 'GATE',
  enhancer: 'ENHANCER',
  volpan: 'VOLUME',
  cab: 'CABINET',
  preset: 'PATCH',
};

// pidLow → catalog family. Takes precedence over BLOCK_TO_FAMILY when set.
// AM4's `amp` user-facing block spans TWO protocol blocks: preamp / power
// amp / speaker live at pidLow 0x003a (DISTORT family); cabinet section
// lives at pidLow 0x003e (CABINET family). Without this override the
// `amp.cabinet_*` entries are miscategorized as DISTORT, which made the
// audit underreport CABINET coverage as 0% (Session 41 actually shipped
// 16 cab entries already).
const PIDLOW_TO_FAMILY: Record<number, string> = {
  0x003e: 'CABINET',
};

// Generic pidHigh range (shared across all blocks — out-of-catalog).
const GENERIC_PIDHIGH_MAX = 9;
const CHANNEL_REGISTER = 0x07d2;

// --- Load Ghidra catalog (optional) ----------------------------------

interface CatalogEntry { paramId: number; name: string; }
const catalogByFamily: Record<string, CatalogEntry[]> = {};
let catalogTotal = 0;

// paramId ≥ 65000 are AM4-Edit internal UI widgets (NAME/LABEL/MENU/
// BUTTON/GRAPH/COPY/METER sentinels), NOT writable preset parameters.
// They show up in the Ghidra catalog because the editor binary
// allocates paramId slots for every UI element, but params.ts
// intentionally omits them. Filter at load time so they're excluded
// from BOTH the family catalog count AND the % calculation —
// matches the UI-WIDGET classification in coverage-cross-ref-audit.ts.
const UI_WIDGET_PARAMID_MIN = 65000;

// GHOST symbols (Session 97 cont 5): catalog has the paramId but
// NO AM4-Edit XML renders a control for it (regular OR expert page,
// across all conditional amp-type variants). These are firmware-
// internal — addressable in theory but with no user-facing UI on
// AM4. Filter them from the headline denominator so coverage %
// reflects ONLY entries the user can see in AM4-Edit. The cross-
// ref audit's GHOST class catalogs them separately for visibility.
//
// If a future HW-114 capture surfaces any GHOST symbol on the AM4
// front-panel Expert Edit menu, wiring it into params.ts (with a
// hardware-verified label) automatically moves it out of GHOST.
const XML_REG = 'samples/captured/decoded/binarydata/extracted/__block_layout.xml';
const XML_EXPERT = 'samples/captured/decoded/binarydata/extracted/__block_layout_expert.xml';
const xmlSymbols = new Set<string>();
for (const xmlPath of [XML_REG, XML_EXPERT]) {
  if (!existsSync(xmlPath)) continue;
  const xml = readFileSync(xmlPath, 'utf-8');
  for (const m of xml.matchAll(/parameterName="([A-Z][A-Z0-9_]*)"/g)) {
    xmlSymbols.add(m[1]);
  }
}

if (existsSync(GHIDRA_AM4)) {
  const raw = JSON.parse(readFileSync(GHIDRA_AM4, 'utf-8'));
  for (const eff of Object.values(raw.effect_types) as any[]) {
    if (!eff.effectFamily) continue;
    const arr: CatalogEntry[] = Array.isArray(eff.params)
      ? eff.params
          .filter((p: any) => p.paramId < UI_WIDGET_PARAMID_MIN)
          // Exclude GHOSTs only when XML data is available — if XML
          // can't be loaded (e.g. fresh clone before BinaryData
          // extraction), fall back to the unfiltered count rather
          // than silently dropping every catalog entry.
          .filter((p: any) => xmlSymbols.size === 0 || xmlSymbols.has(p.name))
          .map((p: any) => ({ paramId: p.paramId, name: p.name }))
      : [];
    catalogByFamily[eff.effectFamily] = arr;
    catalogTotal += arr.length;
  }
}

// --- Parse params.ts entries -----------------------------------------

const paramsTs = readFileSync(PARAMS_TS, 'utf-8');
const entryRe =
  /^\s+'([a-z]+\.[a-z0-9_]+)':\s*\{[\s\S]*?block:\s*'([a-z]+)',\s*name:\s*'([a-z0-9_]+)',[\s\S]*?pidLow:\s*(0x[0-9a-fA-F]+),\s*pidHigh:\s*(0x[0-9a-fA-F]+)/gm;

interface ParamEntry {
  key: string;
  block: string;
  pidLow: number;
  pidHigh: number;
}
const params: ParamEntry[] = [];
for (const m of paramsTs.matchAll(entryRe)) {
  params.push({
    key: m[1],
    block: m[2],
    pidLow: parseInt(m[4], 16),
    pidHigh: parseInt(m[5], 16),
  });
}

// --- Parse verify-msg.ts goldens -------------------------------------
//
// Goldens are 23-byte SET_PARAM hex strings. Position [6,7] = pidLow
// septets, [8,9] = pidHigh septets. We extract (pidLow, pidHigh) pairs
// to map goldens back to params.

const verifyTs = readFileSync(VERIFY_MSG_TS, 'utf-8');
const goldenHexRe = /expected:\s*'(f0[0-9a-f]+f7)'/g;
const goldenPidPairs = new Set<string>();

function decode14(lo: number, hi: number): number {
  return lo | (hi << 7);
}

for (const m of verifyTs.matchAll(goldenHexRe)) {
  const hex = m[1];
  if (hex.length !== 46) continue; // only 23-byte SET_PARAM frames
  const b = (i: number) => parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  if (b(5) !== 0x01) continue; // function byte 0x01 SET_PARAM
  const pidLow = decode14(b(6), b(7));
  const pidHigh = decode14(b(8), b(9));
  goldenPidPairs.add(`${pidLow.toString(16)}.${pidHigh.toString(16)}`);
}

// --- Index params by family ------------------------------------------

interface FamilyCoverage {
  family: string;
  blocks: string[];      // AM4 block names mapped to this family
  catalogCount: number;
  shippedCount: number;
  goldenCount: number;
  genericCount: number;  // shipped entries in pidHigh 0..9 range
  channelCount: number;  // shipped entries at pidHigh=0x07d2
}

const familyMap: Record<string, FamilyCoverage> = {};

// Seed every catalog family even if no params reference it
for (const fam of Object.keys(catalogByFamily)) {
  familyMap[fam] = {
    family: fam,
    blocks: [],
    catalogCount: catalogByFamily[fam].length,
    shippedCount: 0,
    goldenCount: 0,
    genericCount: 0,
    channelCount: 0,
  };
}

// Also seed any block whose family we know but isn't in catalog
for (const [block, family] of Object.entries(BLOCK_TO_FAMILY)) {
  familyMap[family] ??= {
    family,
    blocks: [],
    catalogCount: 0,
    shippedCount: 0,
    goldenCount: 0,
    genericCount: 0,
    channelCount: 0,
  };
  if (!familyMap[family].blocks.includes(block)) familyMap[family].blocks.push(block);
}

// Group families by which catalog paramIds are addressed in params.ts
// (to compute catalog coverage rather than just entry count). Multiple
// blocks → same family means we de-dupe by paramId.
//
// IMPORTANT: only count addressed paramIds that ALSO survive the
// catalog filter (UI-widget + GHOST filter applied above). A params.ts
// entry at paramId X where X is filtered out (GHOST or widget) would
// produce a >100% coverage ratio otherwise.
const catalogParamsAddressed: Record<string, Set<number>> = {};
const catalogParamIdsByFamily: Record<string, Set<number>> = {};
for (const fam of Object.keys(familyMap)) {
  catalogParamsAddressed[fam] = new Set();
  catalogParamIdsByFamily[fam] = new Set(catalogByFamily[fam]?.map((e) => e.paramId) ?? []);
}

for (const p of params) {
  const family = PIDLOW_TO_FAMILY[p.pidLow] ?? BLOCK_TO_FAMILY[p.block];
  if (!family) continue;
  // Ensure the cabinet-overridden family is tracked + recognized as
  // placeable (it gets its block credit via the override even though no
  // entry has block === 'cab').
  if (familyMap[family] && !familyMap[family].blocks.includes(p.block)) {
    familyMap[family].blocks.push(p.block);
  }
  const fc = familyMap[family];
  if (!fc) continue;
  fc.shippedCount += 1;
  if (p.pidHigh === CHANNEL_REGISTER) {
    fc.channelCount += 1;
  } else if (p.pidHigh <= GENERIC_PIDHIGH_MAX) {
    fc.genericCount += 1;
  } else {
    // pidHigh in catalog-paramId range — count toward catalog coverage
    // only if the paramId survives the catalog filter (i.e. it's an
    // XML-rendered, non-UI-widget catalog entry).
    if (catalogParamIdsByFamily[family]?.has(p.pidHigh)) {
      catalogParamsAddressed[family].add(p.pidHigh);
    }
  }
  if (goldenPidPairs.has(`${p.pidLow.toString(16)}.${p.pidHigh.toString(16)}`)) {
    fc.goldenCount += 1;
  }
}

// --- Render the report -----------------------------------------------

function pad(s: string | number, w: number): string {
  const str = String(s);
  return str.length >= w ? str : str + ' '.repeat(w - str.length);
}
function padl(s: string | number, w: number): string {
  const str = String(s);
  return str.length >= w ? str : ' '.repeat(w - str.length) + str;
}

console.log('═══════════════════════════════════════════════════════════════════════');
console.log('  Coverage audit  (' + new Date().toISOString() + ')');
console.log('═══════════════════════════════════════════════════════════════════════');
console.log('');
console.log(`AM4 ${PARAMS_TS}: ${params.length} entries`);
console.log(`Ghidra catalog: ${existsSync(GHIDRA_AM4) ? `${Object.keys(catalogByFamily).length} families, ${catalogTotal} paramIds` : 'NOT PRESENT (regenerate via scripts/ghidra/run-am4-paramnames.cmd)'}`);
console.log(`Goldens with SET_PARAM wire bytes: ${goldenPidPairs.size} distinct (pidLow, pidHigh) pairs`);
console.log('');

// Split families into AM4-placeable (has at least one AM4 block mapped)
// vs product-line-only (in Ghidra catalog but not placeable on AM4).
// The Ghidra catalog is product-line-wide (Axe-Fx III / FM9 / FM3 /
// AM4) — families like PITCH / MULTITAP / PLEX / VOCODER live on
// larger Fractal hardware, not on AM4's 4-slot pedal. Mixing them
// into one TOTAL produces a misleading "AM4 coverage" headline.

const placeable = Object.values(familyMap)
  .filter((f) => f.blocks.length > 0)
  .sort((a, b) => b.catalogCount - a.catalogCount);
const productLineOnly = Object.values(familyMap)
  .filter((f) => f.catalogCount > 0 && f.blocks.length === 0)
  .sort((a, b) => b.catalogCount - a.catalogCount);

function renderFamilyTable(rows: FamilyCoverage[], totalLabel: string): void {
  console.log(
    '  ' + pad('Family', 12) + pad('Blocks', 22) +
    padl('Catalog', 9) + padl('In params.ts', 14) + padl('Goldens', 10) + '  ' + 'Catalog %'
  );
  console.log('  ' + '─'.repeat(78));
  let tC = 0, tS = 0, tG = 0, tA = 0;
  for (const f of rows) {
    const addressedFromCatalog = catalogParamsAddressed[f.family]?.size ?? 0;
    const pct = f.catalogCount > 0
      ? `${Math.round((addressedFromCatalog / f.catalogCount) * 100)}%`
      : '—';
    console.log(
      '  ' + pad(f.family, 12) + pad(f.blocks.join(', ') || '—', 22) +
      padl(f.catalogCount || '—', 9) + padl(f.shippedCount || '—', 14) + padl(f.goldenCount || '—', 10) + '  ' + pct
    );
    tC += f.catalogCount;
    tS += f.shippedCount;
    tG += f.goldenCount;
    tA += addressedFromCatalog;
  }
  console.log('  ' + '─'.repeat(78));
  const pct = tC > 0 ? `${Math.round((tA / tC) * 100)}%` : '—';
  console.log(
    '  ' + pad(totalLabel, 12) + pad('', 22) +
    padl(tC, 9) + padl(tS, 14) + padl(tG, 10) + '  ' + pct
  );
}

console.log('AM4 PARAM COVERAGE — placeable families only');
console.log('  Families with at least one AM4 block mapped. This is the real');
console.log('  AM4 denominator — the TOTAL % is meaningful AM4 coverage.');
console.log('');
renderFamilyTable(placeable, 'AM4 TOTAL');
console.log('');

if (productLineOnly.length > 0) {
  console.log('Ghidra catalog families NOT placeable on AM4 (Fractal product-line scope)');
  console.log('  These families live in the editor binary because Axe-Fx III / FM9 /');
  console.log('  FM3 share the codebase. AM4\'s 4-slot pedal does not expose them, so');
  console.log('  they don\'t count against AM4 coverage. Listed here for awareness:');
  console.log('');
  for (const f of productLineOnly) {
    console.log(`  ${pad(f.family, 14)} ${padl(f.catalogCount, 4)} paramIds catalog-known`);
  }
  console.log('');
}

// Devices: param/tool registration counts for non-AM4 packages.
// Each device uses a different entry format, so we count via a
// device-specific signature pattern.
const deviceFiles = [
  {
    device: 'Axe-Fx II',
    path: join(FRACTAL_MIDI_AXEFX2_DIR, 'params.js'),
    // II uses object-array entries keyed by `groupCode`/`paramId` with
    // double-quoted values (auto-generated, JSON-style).
    signature: /groupCode:\s*["']/g,
  },
  {
    device: 'Axe-Fx III',
    path: join(FRACTAL_MIDI_AXEFX3_DIR, 'blockTypes.js'),
    // III currently exposes blocks (not per-param) through blockTypes.ts.
    // Count `firstId:` lines as a block count proxy until per-param ships.
    signature: /firstId:\s/g,
    label: 'block entries (no per-param decode yet — III SET_PARAM undecoded)',
  },
  {
    device: 'Hydrasynth',
    path: 'packages/hydrasynth/src/params.ts',
    // Hydra uses object-array entries with `cc:` as the key field.
    signature: /\bcc:\s*\d/g,
  },
];

console.log('OTHER DEVICES');
console.log('');
for (const { device, path, signature, label } of deviceFiles) {
  if (existsSync(path)) {
    const src = readFileSync(path, 'utf-8');
    const count = (src.match(signature) || []).length;
    console.log(`  ${pad(device, 14)} ${padl(count, 4)} ${label ?? 'param entries'} (${path})`);
  } else {
    console.log(`  ${pad(device, 14)}    — (no params.ts; uses different surface)`);
  }
}
console.log('');

// What the audit DOESN'T tell you — direct ask for the open work
console.log('READ THIS WHEN PLANNING NEXT WORK');
console.log('');
console.log('  • The "AM4 TOTAL" row is the real AM4 coverage. Earlier versions');
console.log('    mixed product-line-only families into that total and produced a');
console.log('    misleading sub-20% headline — those families aren\'t AM4 blocks.');
console.log('  • Catalog % counts only entries with pidHigh >= 10 — generic params');
console.log('    (level/mix/balance/bypass at pidHigh 0-9, plus channel-select at');
console.log('    0x07D2) are NOT in the catalog and are counted separately in the');
console.log('    "In params.ts" column.');
console.log('  • Goldens column counts entries where verify-msg.ts has a byte-');
console.log('    exact wire test. Entries without goldens are unverified end-to-end.');
console.log('  • Axe-Fx III shows 0 per-param coverage because SET_PARAM is still');
console.log('    undecoded. Cracking one III SET_PARAM frame unlocks 2216 paramIds');
console.log('    that already live in the III Ghidra catalog. Single biggest unlock.');
console.log('');
