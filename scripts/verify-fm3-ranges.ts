/**
 * Gate: the generated FM3 device-true display ranges must keep their validated
 * shape: the evidence anchors (REVERB_TIME 0.1..100 step 0.02 at FM3-true
 * paramId 1, amp/drive/reverb enum counts 331/86/79 at their FM3-true ids
 * DISTORT 6 / FUZZ 0 / REVERB 0), the cache-internal stride invariants, the
 * FM3's 2-input / 2-output instance groups, and a panel of spot rows read
 * directly from the fw 12.0 community cache walk JSON at authoring time
 * (samples/captured/fm3-community-2026-06-27, GitHub issues #7/#8; the
 * contributor's independent clone of the FM9 pipeline reported the same
 * 1831 rows / 39 families this generator produces). A bad regeneration
 * (wrong cache, broken section-to-family vote, scale misapplied) fails here
 * instead of silently shipping wrong ranges.
 *
 * Also gates the BK-096 Hz-cut log10 wiring at the catalog layer: the FM3
 * field point (2026-06-12: float32(45.0) SET on REVERB_LOWCUT read back wire
 * 11540 = exactly 45.0 Hz under 20*100^(w/65534)) must round-trip through the
 * shipped FM3 descriptor schema.
 *
 * When the source walk JSON is present locally (samples/ is gitignored), every
 * generated row is additionally cross-checked against it; on machines without
 * the capture the hard-coded panel still runs.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FM3_RANGES,
  FM3_RANGE_SECTIONS,
  type Fm3ParamRange,
} from '../packages/fractal-midi/src/gen3/fm3/ranges.generated.js';
import { FM3_DESCRIPTOR } from '@mcp-midi-control/fractal-gen3/device.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const WALK = resolve(root, 'samples/captured/fm3-community-2026-06-27/effectDefinitions_11_12p0.walk.json');

let failed = 0;
function check(label: string, cond: boolean, detail: string): void {
  if (cond) {
    console.log(`  ok    ${label}`);
  } else {
    console.error(`  FAIL  ${label} (${detail})`);
    failed++;
  }
}

function row(family: string, id: number): Fm3ParamRange | undefined {
  return FM3_RANGES[family]?.[id];
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
// Evidence anchors (FM3-true paramIds; note the id layout differs from the
// FM9: REVERB_TYPE/TIME are 0/1 here, DISTORT_TYPE is 6)
// ---------------------------------------------------------------------------
console.log('evidence anchors:');
checkRow('REVERB', 1, { kind: 'float', displayMin: 0.1, displayMax: 100, scale: 1, step: 0.02 },
  'REVERB_TIME = (0.1, 100, scale 1, step 0.02), family anchor (FM9-hardware-confirmed range + sweep)');
check('DISTORT[6] amp enum count = 331 (FM3 fw 12.0 cache)', row('DISTORT', 6)?.enumCount === 331,
  `got ${row('DISTORT', 6)?.enumCount}`);
check('FUZZ[0] drive enum count = 86 (FM3 fw 12.0 cache)', row('FUZZ', 0)?.enumCount === 86,
  `got ${row('FUZZ', 0)?.enumCount}`);
check('REVERB[0] reverb-type enum count = 79', row('REVERB', 0)?.enumCount === 79,
  `got ${row('REVERB', 0)?.enumCount}`);

// ---------------------------------------------------------------------------
// Strides / sections / instance groups
// ---------------------------------------------------------------------------
console.log('strides / sections:');
check('DISTORT stride = 144 (section 10)', FM3_RANGE_SECTIONS.DISTORT?.stride === 144,
  `got ${FM3_RANGE_SECTIONS.DISTORT?.stride}`);
check('REVERB stride = 71 (section 12)', FM3_RANGE_SECTIONS.REVERB?.stride === 71,
  `got ${FM3_RANGE_SECTIONS.REVERB?.stride}`);
check('CABINET wire stride = 106, raw recordCount = 110 (4 special cab-table records)',
  FM3_RANGE_SECTIONS.CABINET?.stride === 106 && FM3_RANGE_SECTIONS.CABINET?.recordCount === 110,
  `got stride ${FM3_RANGE_SECTIONS.CABINET?.stride} recordCount ${FM3_RANGE_SECTIONS.CABINET?.recordCount}`);
check('GLOBAL wire stride 186 excludes its 0xffff name-table record (recordCount 187)',
  FM3_RANGE_SECTIONS.GLOBAL?.stride === 186 && FM3_RANGE_SECTIONS.GLOBAL?.recordCount === 187,
  `got stride ${FM3_RANGE_SECTIONS.GLOBAL?.stride} recordCount ${FM3_RANGE_SECTIONS.GLOBAL?.recordCount}`);
check('every family: stride <= recordCount and stride counts the emitted ordinary rows',
  Object.entries(FM3_RANGE_SECTIONS).every(([f, m]) =>
    m.stride <= m.recordCount && m.stride === Object.keys(FM3_RANGES[f] ?? {}).length),
  'a family has stride > recordCount or stride != emitted row count');
check('INPUT instance sections = 41..42 (the FM3 has 2 input blocks)',
  JSON.stringify(FM3_RANGE_SECTIONS.INPUT?.instanceTags) === '[41,42]',
  `got ${JSON.stringify(FM3_RANGE_SECTIONS.INPUT?.instanceTags)}`);
check('OUTPUT instance sections = 46..47 (the FM3 has 2 output blocks)',
  JSON.stringify(FM3_RANGE_SECTIONS.OUTPUT?.instanceTags) === '[46,47]',
  `got ${JSON.stringify(FM3_RANGE_SECTIONS.OUTPUT?.instanceTags)}`);
check('total rows = 1831 across 39 families (matches the issue #7/#8 contributor cross-run)',
  Object.values(FM3_RANGES).reduce((a, fam) => a + Object.keys(fam).length, 0) === 1831 &&
    Object.keys(FM3_RANGES).length === 39,
  `got ${Object.values(FM3_RANGES).reduce((a, fam) => a + Object.keys(fam).length, 0)} rows / ${Object.keys(FM3_RANGES).length} families`);

// ---------------------------------------------------------------------------
// Spot rows, values read directly from effectDefinitions_11_12p0.walk.json
// (sections 10/12/13/11/41/46/29; display = cache value * scale)
// ---------------------------------------------------------------------------
console.log('cache spot rows:');
checkRow('DISTORT', 7, { kind: 'float', displayMin: 0, displayMax: 10, scale: 10, step: 0.001 },
  'DISTORT_DRIVE 0..1 scale 10 -> 0..10 knob');
checkRow('DISTORT', 1, { kind: 'float', displayMin: -80, displayMax: 20, scale: 1, step: 0.1 },
  'DISTORT_LEVEL -80..20 dB');
checkRow('REVERB', 13, { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001 },
  'REVERB_MIX 0..1 scale 100 -> 0..100 %');
checkRow('REVERB', 2, { kind: 'float', displayMin: 200, displayMax: 20000, scale: 1, step: 0 },
  'REVERB_HICUT 200..20000 Hz');
checkRow('REVERB', 10, { kind: 'float', displayMin: 20, displayMax: 2000, scale: 1, step: 0 },
  'REVERB_LOWCUT 20..2000 Hz (the BK-096 field-point param)');
checkRow('REVERB', 9, { kind: 'float', displayMin: 0, displayMax: 1000, scale: 1000, step: 0.00025 },
  'REVERB_PREDELAY 0..1 scale 1000 -> 0..1000 ms (device-true; AM4-inherited 0..250 superseded)');
checkRow('DELAY', 8, { kind: 'float', displayMin: 1, displayMax: 16000, scale: 1000, step: 0.001 },
  'DELAY_TIME 0.001..16 scale 1000 -> 1..16000 ms (device-true 16 s ceiling)');
checkRow('DELAY', 0, { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001 },
  'DELAY_MIX 0..100 %');
checkRow('CABINET', 8, { kind: 'float', displayMin: -40, displayMax: 0, scale: 1, step: 0.05 },
  'CABINET_LEVEL1 -40..0 dB');
checkRow('CABINET', 0, { kind: 'enum', displayMin: 0, displayMax: 4, scale: 1, step: 1, enumCount: 5 },
  'CABINET_BANK1 5-entry bank enum (FM3 has 5 cab banks, vs 6 on the III)');
checkRow('INPUT', 4, { kind: 'enum', displayMin: 0, displayMax: 12, scale: 1, step: 0, enumCount: 13 },
  'INPUT_Z 13-entry impedance enum');
checkRow('OUTPUT', 0, { kind: 'float', displayMin: -20, displayMax: 20, scale: 1, step: 0.04 },
  'OUTPUT_LEVEL1 -20..20 dB trim');
checkRow('FDBKSEND', 0, { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001 },
  'FDBKSEND_SENDLEVEL 0..100 % (exact-cover section 29)');

// ---------------------------------------------------------------------------
// Catalog wiring: FM3_RANGES must actually reach the shipped descriptor
// (deviceRanges per model byte), incl. the BK-096 log10 field point
// ---------------------------------------------------------------------------
console.log('descriptor wiring (deviceRanges + BK-096 log10):');
{
  const reverb = FM3_DESCRIPTOR.blocks['reverb']?.params;
  const delay = FM3_DESCRIPTOR.blocks['delay']?.params;
  const cab = FM3_DESCRIPTOR.blocks['cab']?.params;
  check('reverb.lowcut encode(45 Hz) = wire 11540 (FM3 field point 2026-06-12, log10)',
    reverb?.['lowcut']?.encode(45) === 11540, `got ${reverb?.['lowcut']?.encode(45)}`);
  check('reverb.lowcut decode(11540) = 45 Hz', reverb?.['lowcut']?.decode(11540) === 45,
    `got ${reverb?.['lowcut']?.decode(11540)}`);
  check('delay.time advertises the device-true 1..16000 ms window',
    delay?.['time']?.display_min === 1 && delay?.['time']?.display_max === 16000,
    `got ${delay?.['time']?.display_min}..${delay?.['time']?.display_max}`);
  check('cab.locut is display-calibrated 20..2000 Hz (cab polish auto-apply premise)',
    cab?.['locut']?.display_min === 20 && cab?.['locut']?.display_max === 2000,
    `got ${cab?.['locut']?.display_min}..${cab?.['locut']?.display_max}`);
  const w80 = cab?.['locut']?.encode(80);
  check('cab.locut encode(80 Hz) is log10 (wire ~19728, not linear ~1986)',
    typeof w80 === 'number' && Math.abs(w80 - 19728) <= 2, `got ${w80}`);
}

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
  const near = (a: number, b: number) =>
    Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b));
  let rows = 0;
  let bad = 0;
  for (const [family, meta] of Object.entries(FM3_RANGE_SECTIONS)) {
    const sec = bySec.get(meta.sectionTag);
    for (const [idStr, g] of Object.entries(FM3_RANGES[family] ?? {})) {
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
  console.error(`\nverify-fm3-ranges: ${failed} check(s) FAILED`);
  process.exit(1);
}
console.log('\nverify-fm3-ranges: all checks passed (device-true ranges, anchors + strides + spot panel + descriptor wiring valid)');
