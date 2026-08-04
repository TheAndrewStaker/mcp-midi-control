/**
 * Gate: the generated FM9 device-true display ranges must keep their validated
 * shape: the hardware anchors (REVERB_TIME 0.1..100 step 0.02, amp/FUZZ/reverb
 * enum counts 336/87/79 as of the fw 12.0 cache — grew from 331/86 on fw 11.0
 * as firmware appended new amp/drive models, issue #19), the wire-confirmed
 * fn=0x1F strides (DISTORT 147, REVERB 73, plus CABINET 106 = ordinary records
 * only, excluding the 4 special cab-table records the cache section also
 * counts; sub=0x01 block-definition cross-validated), and a panel of spot rows
 * read directly from the fw 12.0 cache walk JSON at authoring time. A bad
 * regeneration (wrong cache, broken section-to-family vote, scale misapplied)
 * fails here instead of silently shipping wrong ranges.
 *
 * When the source walk JSON is present locally (samples/ is gitignored), every
 * generated row is additionally cross-checked against it; on machines without
 * the capture the hard-coded panel still runs.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FM9_RANGES,
  FM9_RANGE_SECTIONS,
  type Fm9ParamRange,
} from '../packages/fractal-midi/src/gen3/fm9/ranges.generated.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const WALK = resolve(root, 'samples/captured/fm9-community-2026-07-18/effectDefinitions_12_12p0.walk.json');

let failed = 0;
function check(label: string, cond: boolean, detail: string): void {
  if (cond) {
    console.log(`  ok    ${label}`);
  } else {
    console.error(`  FAIL  ${label} (${detail})`);
    failed++;
  }
}

function row(family: string, id: number): Fm9ParamRange | undefined {
  return FM9_RANGES[family]?.[id];
}

function checkRow(
  family: string,
  id: number,
  exp: { kind: 'enum' | 'float'; displayMin: number; displayMax: number; scale: number; step: number; enumCount?: number },
  why: string,
): void {
  const r = row(family, id);
  const got = r
    ? `kind=${r.kind} ${r.displayMin}..${r.displayMax} scale=${r.scale} step=${r.step}${r.enumCount !== undefined ? ` enumCount=${r.enumCount}` : ''}`
    : 'missing';
  const ok =
    !!r &&
    r.kind === exp.kind &&
    r.displayMin === exp.displayMin &&
    r.displayMax === exp.displayMax &&
    r.scale === exp.scale &&
    r.step === exp.step &&
    r.enumCount === exp.enumCount;
  check(`${family}[${id}] ${why}`, ok, `got ${got}`);
}

// ---------------------------------------------------------------------------
// Hardware anchors (FINDINGS.md Finding 1/2/3 + CACHE-FORMAT-SOLVED-2026-06-09)
// ---------------------------------------------------------------------------
console.log('hardware anchors:');
checkRow('REVERB', 11, { kind: 'float', displayMin: 0.1, displayMax: 100, scale: 1, step: 0.02 },
  'REVERB_TIME = (0.1, 100, scale 1, step 0.02), hardware-confirmed range + sweep');
check('DISTORT[10] amp enum count = 336 (fw 12.0; was 331 on fw 11.0)', row('DISTORT', 10)?.enumCount === 336,
  `got ${row('DISTORT', 10)?.enumCount}`);
check('FUZZ[0] drive enum count = 87 (fw 12.0; was 86 on fw 11.0)', row('FUZZ', 0)?.enumCount === 87,
  `got ${row('FUZZ', 0)?.enumCount}`);
check('REVERB[10] reverb-type enum count = 79', row('REVERB', 10)?.enumCount === 79,
  `got ${row('REVERB', 10)?.enumCount}`);

// ---------------------------------------------------------------------------
// Wire-confirmed strides + instance groups
// ---------------------------------------------------------------------------
console.log('strides / sections:');
check('DISTORT stride = 147 (fn=0x1F wire-confirmed)', FM9_RANGE_SECTIONS.DISTORT?.stride === 147,
  `got ${FM9_RANGE_SECTIONS.DISTORT?.stride}`);
check('REVERB stride = 73 (fn=0x1F wire-confirmed)', FM9_RANGE_SECTIONS.REVERB?.stride === 73,
  `got ${FM9_RANGE_SECTIONS.REVERB?.stride}`);
check('CABINET wire stride = 106 (sub=0x01 block-definition cross-validated; ordinary records only)',
  FM9_RANGE_SECTIONS.CABINET?.stride === 106, `got ${FM9_RANGE_SECTIONS.CABINET?.stride}`);
check('CABINET raw recordCount = 110 (incl. 4 special 0xfff0..0xfff3 cab-table records)',
  FM9_RANGE_SECTIONS.CABINET?.recordCount === 110, `got ${FM9_RANGE_SECTIONS.CABINET?.recordCount}`);
check('GLOBAL wire stride 224 excludes its 0xffff name-table record (recordCount 225)',
  FM9_RANGE_SECTIONS.GLOBAL?.stride === 224 && FM9_RANGE_SECTIONS.GLOBAL?.recordCount === 225,
  `got stride ${FM9_RANGE_SECTIONS.GLOBAL?.stride} recordCount ${FM9_RANGE_SECTIONS.GLOBAL?.recordCount}`);
check('every family: stride <= recordCount and stride counts the emitted ordinary rows',
  Object.entries(FM9_RANGE_SECTIONS).every(([f, m]) =>
    m.stride <= m.recordCount && m.stride === Object.keys(FM9_RANGES[f] ?? {}).length),
  'a family has stride > recordCount or stride != emitted row count');
check('INPUT instance sections = 41..44', JSON.stringify(FM9_RANGE_SECTIONS.INPUT?.instanceTags) === '[41,42,43,44]',
  `got ${JSON.stringify(FM9_RANGE_SECTIONS.INPUT?.instanceTags)}`);
check('OUTPUT instance sections = 46..48', JSON.stringify(FM9_RANGE_SECTIONS.OUTPUT?.instanceTags) === '[46,47,48]',
  `got ${JSON.stringify(FM9_RANGE_SECTIONS.OUTPUT?.instanceTags)}`);

// ---------------------------------------------------------------------------
// Spot rows, values read directly from effectDefinitions_12_12p0.walk.json
// (sections 10/12/13/11/41/46/29/57; display = cache value * scale)
// ---------------------------------------------------------------------------
console.log('cache spot rows:');
checkRow('DISTORT', 11, { kind: 'float', displayMin: 0, displayMax: 10, scale: 10, step: 0.001 },
  'DISTORT_DRIVE 0..1 scale 10 -> 0..10 knob');
checkRow('DISTORT', 1, { kind: 'float', displayMin: -80, displayMax: 20, scale: 1, step: 0.1 },
  'DISTORT_LEVEL -80..20 dB');
checkRow('REVERB', 0, { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001 },
  'REVERB_MIX 0..1 scale 100 -> 0..100 %');
checkRow('REVERB', 12, { kind: 'float', displayMin: 200, displayMax: 20000, scale: 1, step: 0 },
  'REVERB_HICUT 200..20000 Hz');
checkRow('REVERB', 19, { kind: 'float', displayMin: 0, displayMax: 1000, scale: 1000, step: 0.00025 },
  'REVERB_PREDELAY 0..1 scale 1000 -> 0..1000 ms (FM9-true; AM4-inherited 0..250 superseded)');
checkRow('DELAY', 12, { kind: 'float', displayMin: 1, displayMax: 16000, scale: 1000, step: 0.001 },
  'DELAY_TIME 0.001..16 scale 1000 -> 1..16000 ms (FM9-true 16 s ceiling)');
checkRow('DELAY', 0, { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001 },
  'DELAY_MIX 0..100 %');
checkRow('CABINET', 8, { kind: 'float', displayMin: -40, displayMax: 0, scale: 1, step: 0.05 },
  'CABINET_LEVEL1 -40..0 dB');
checkRow('CABINET', 0, { kind: 'enum', displayMin: 0, displayMax: 4, scale: 1, step: 1, enumCount: 5 },
  'CABINET_BANK1 5-entry bank enum');
checkRow('INPUT', 4, { kind: 'enum', displayMin: 0, displayMax: 12, scale: 1, step: 0, enumCount: 13 },
  'INPUT_Z 13-entry impedance enum (AUTO/1M/1M+CAP/...)');
checkRow('INPUT', 0, { kind: 'float', displayMin: -100, displayMax: 0, scale: 1, step: 0.1 },
  'INPUT_THRESH -100..0 dB');
checkRow('OUTPUT', 0, { kind: 'float', displayMin: -20, displayMax: 20, scale: 1, step: 0.04 },
  'OUTPUT_LEVEL1 -20..20 dB trim');
checkRow('FDBKSEND', 0, { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001 },
  'FDBKSEND_SENDLEVEL 0..100 % (exact-cover section 29)');
checkRow('PRESET', 1285, { kind: 'enum', displayMin: 0, displayMax: 2, scale: 1, step: 1, enumCount: 3 },
  'PRESET_FC_SCENE1_CS1_MODE 3-entry ON/OFF/LAST enum (sparse-id section 57)');

// ---------------------------------------------------------------------------
// Full cross-check against the walk JSON, when the capture is present locally
// ---------------------------------------------------------------------------
if (existsSync(WALK)) {
  const walk = JSON.parse(readFileSync(WALK, 'utf8')) as {
    records: { kind: string; section: number; id: number; min: number; max: number; def: number; count?: number }[];
  };
  const bySec = new Map<number, Map<number, (typeof walk.records)[number]>>();
  for (const r of walk.records) {
    if (r.id >= 0xff00) continue;
    let m = bySec.get(r.section);
    if (!m) bySec.set(r.section, (m = new Map()));
    m.set(r.id, r);
  }
  // Same tolerance the generator snaps with: 1e-6 relative (absolute below 1).
  const near = (a: number, b: number) =>
    Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b));
  let rows = 0;
  let bad = 0;
  for (const [family, meta] of Object.entries(FM9_RANGE_SECTIONS)) {
    const sec = bySec.get(meta.sectionTag);
    for (const [idStr, g] of Object.entries(FM9_RANGES[family] ?? {})) {
      rows++;
      const r = sec?.get(Number(idStr));
      const scaleOr1 = r && r.def !== 0 ? r.def : 1;
      const ok =
        !!r &&
        g.kind === r.kind &&
        near(g.displayMin, r.min * scaleOr1) &&
        near(g.displayMax, r.max * scaleOr1) &&
        near(g.scale, r.def) &&
        g.enumCount === r.count;
      if (!ok) bad++;
    }
  }
  check(`walk-JSON cross-check: all ${rows} generated rows match the cache walk`, bad === 0, `${bad} mismatching rows`);
} else {
  console.log('  (walk JSON not present locally; hard-coded panel only)');
}

if (failed > 0) {
  console.error(`\nverify-fm9-ranges: ${failed} check(s) FAILED`);
  process.exit(1);
}
console.log('\nverify-fm9-ranges: all checks passed (device-true ranges, anchors + strides + spot panel valid)');
