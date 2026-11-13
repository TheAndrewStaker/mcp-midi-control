/**
 * Gate: the generated Axe-Fx III device-true display ranges must keep their
 * validated shape: the evidence anchors (REVERB_TIME 0.1..100 step 0.02 at
 * III-true paramId 1, amp/drive/reverb enum counts 336/87/79 at DISTORT 0 /
 * FUZZ 0 / REVERB 0), the cache-internal stride invariants, the III's
 * 5-input / 4-output instance groups, and a panel of spot rows read directly
 * from the community cache walk JSON at authoring time
 * (samples/captured/axefx3-community-2026-07-02). A bad regeneration (wrong
 * cache, broken section-to-family vote, scale misapplied) fails here instead
 * of silently shipping wrong ranges.
 *
 * CONFLICT RULE (the III is the gen-3 byte-identity anchor): where the cache
 * and the 2026-06-18 catalog-wide SET->GET roundtrip oracle disagree, the
 * ROUNDTRIP (device behavior) wins at the catalog layer. This gate asserts
 * the two resolution mechanisms on the shipped descriptor:
 *   - KIND conflicts (35 params the cache marks float but the roundtrip
 *     proved the device quantizes to ordinals): stay routed DISCRETE, and do
 *     NOT advertise the cache's float window as their display range;
 *   - ORDINAL-BOUND conflict (DELAY_SVFTYPE: cache enumCount 3 vs roundtrip
 *     maxOrdinal 3): the roundtrip bound wins, so ordinal 3 encodes.
 *
 * When the source walk JSON is present locally (samples/ is gitignored), every
 * generated row is additionally cross-checked against it; on machines without
 * the capture the hard-coded panel still runs.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  III_RANGES,
  III_RANGE_SECTIONS,
  type AxeFxIIIParamRange,
} from '../packages/fractal-midi/src/gen3/axe-fx-iii/ranges.generated.js';
import { III_ROUNDTRIP_DISCRETE } from '../packages/fractal-midi/src/gen3/axe-fx-iii/roundtripDiscrete.generated.js';
import { AXEFX3_DESCRIPTOR } from '@mcp-midi-control/fractal-gen3/device.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const WALK = resolve(root, 'samples/captured/axefx3-community-2026-07-02/effectDefinitions_10_32p6.walk.json');

let failed = 0;
function check(label: string, cond: boolean, detail: string): void {
  if (cond) {
    console.log(`  ok    ${label}`);
  } else {
    console.error(`  FAIL  ${label} (${detail})`);
    failed++;
  }
}

function row(family: string, id: number): AxeFxIIIParamRange | undefined {
  return III_RANGES[family]?.[id];
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
// Evidence anchors (III-true paramIds: TYPE selectors sit at id 0)
// ---------------------------------------------------------------------------
console.log('evidence anchors:');
checkRow('REVERB', 1, { kind: 'float', displayMin: 0.1, displayMax: 100, scale: 1, step: 0.02 },
  'REVERB_TIME = (0.1, 100, scale 1, step 0.02), family anchor (FM9-hardware-confirmed range + sweep)');
check('DISTORT[0] amp enum count = 336', row('DISTORT', 0)?.enumCount === 336,
  `got ${row('DISTORT', 0)?.enumCount}`);
check('FUZZ[0] drive enum count = 87', row('FUZZ', 0)?.enumCount === 87,
  `got ${row('FUZZ', 0)?.enumCount}`);
check('REVERB[0] reverb-type enum count = 79', row('REVERB', 0)?.enumCount === 79,
  `got ${row('REVERB', 0)?.enumCount}`);

// ---------------------------------------------------------------------------
// Strides / sections / instance groups
// ---------------------------------------------------------------------------
console.log('strides / sections:');
check('DISTORT stride = 142 (section 10)', III_RANGE_SECTIONS.DISTORT?.stride === 142,
  `got ${III_RANGE_SECTIONS.DISTORT?.stride}`);
check('REVERB stride = 71 (section 12)', III_RANGE_SECTIONS.REVERB?.stride === 71,
  `got ${III_RANGE_SECTIONS.REVERB?.stride}`);
check('CABINET wire stride = 106, raw recordCount = 112 (6 special cab-table records)',
  III_RANGE_SECTIONS.CABINET?.stride === 106 && III_RANGE_SECTIONS.CABINET?.recordCount === 112,
  `got stride ${III_RANGE_SECTIONS.CABINET?.stride} recordCount ${III_RANGE_SECTIONS.CABINET?.recordCount}`);
check('GLOBAL wire stride 265 excludes its 0xffff name-table record (recordCount 266)',
  III_RANGE_SECTIONS.GLOBAL?.stride === 265 && III_RANGE_SECTIONS.GLOBAL?.recordCount === 266,
  `got stride ${III_RANGE_SECTIONS.GLOBAL?.stride} recordCount ${III_RANGE_SECTIONS.GLOBAL?.recordCount}`);
check('every family: stride <= recordCount and stride counts the emitted ordinary rows',
  Object.entries(III_RANGE_SECTIONS).every(([f, m]) =>
    m.stride <= m.recordCount && m.stride === Object.keys(III_RANGES[f] ?? {}).length),
  'a family has stride > recordCount or stride != emitted row count');
check('INPUT instance sections = 41..45 (the III has 5 input blocks)',
  JSON.stringify(III_RANGE_SECTIONS.INPUT?.instanceTags) === '[41,42,43,44,45]',
  `got ${JSON.stringify(III_RANGE_SECTIONS.INPUT?.instanceTags)}`);
check('OUTPUT instance sections = 46..49 (the III has 4 output blocks)',
  JSON.stringify(III_RANGE_SECTIONS.OUTPUT?.instanceTags) === '[46,47,48,49]',
  `got ${JSON.stringify(III_RANGE_SECTIONS.OUTPUT?.instanceTags)}`);
check('total rows = 1909 across 43 families',
  Object.values(III_RANGES).reduce((a, fam) => a + Object.keys(fam).length, 0) === 1909 &&
    Object.keys(III_RANGES).length === 43,
  `got ${Object.values(III_RANGES).reduce((a, fam) => a + Object.keys(fam).length, 0)} rows / ${Object.keys(III_RANGES).length} families`);

// ---------------------------------------------------------------------------
// Spot rows, values read directly from effectDefinitions_10_32p6.walk.json
// (sections 10/12/13/11/41/46/29; display = cache value * scale)
// ---------------------------------------------------------------------------
console.log('cache spot rows:');
checkRow('DISTORT', 1, { kind: 'float', displayMin: 0, displayMax: 10, scale: 10, step: 0.001 },
  'DISTORT_DRIVE 0..1 scale 10 -> 0..10 knob');
checkRow('DISTORT', 21, { kind: 'float', displayMin: -80, displayMax: 20, scale: 1, step: 0.1 },
  'DISTORT_LEVEL -80..20 dB');
checkRow('REVERB', 13, { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001 },
  'REVERB_MIX 0..1 scale 100 -> 0..100 %');
checkRow('REVERB', 2, { kind: 'float', displayMin: 200, displayMax: 20000, scale: 1, step: 0 },
  'REVERB_HICUT 200..20000 Hz');
checkRow('REVERB', 10, { kind: 'float', displayMin: 20, displayMax: 2000, scale: 1, step: 0 },
  'REVERB_LOWCUT 20..2000 Hz (BK-096 log10 family)');
checkRow('REVERB', 9, { kind: 'float', displayMin: 0, displayMax: 1000, scale: 1000, step: 0.00025 },
  'REVERB_PREDELAY 0..1 scale 1000 -> 0..1000 ms (device-true; AM4-inherited 0..250 superseded)');
checkRow('DELAY', 2, { kind: 'float', displayMin: 1, displayMax: 16000, scale: 1000, step: 0.001 },
  'DELAY_TIME 0.001..16 scale 1000 -> 1..16000 ms (device-true 16 s ceiling)');
checkRow('DELAY', 17, { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001 },
  'DELAY_MIX 0..100 %');
checkRow('CABINET', 8, { kind: 'float', displayMin: -40, displayMax: 0, scale: 1, step: 0.05 },
  'CABINET_LEVEL1 -40..0 dB');
checkRow('CABINET', 0, { kind: 'enum', displayMin: 0, displayMax: 5, scale: 1, step: 1, enumCount: 6 },
  'CABINET_BANK1 6-entry bank enum (the III has 6 cab banks, vs 5 on FM3/FM9)');
checkRow('INPUT', 4, { kind: 'enum', displayMin: 0, displayMax: 12, scale: 1, step: 0, enumCount: 13 },
  'INPUT_Z 13-entry impedance enum');
checkRow('OUTPUT', 0, { kind: 'float', displayMin: -20, displayMax: 20, scale: 1, step: 0.04 },
  'OUTPUT_LEVEL1 -20..20 dB trim');
checkRow('FDBKSEND', 0, { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001 },
  'FDBKSEND_SENDLEVEL 0..100 % (exact-cover section 29)');

// ---------------------------------------------------------------------------
// Cache-vs-roundtrip conflict resolution on the shipped descriptor
// (roundtrip = device behavior = wins)
// ---------------------------------------------------------------------------
console.log('cache-vs-roundtrip conflict rule (roundtrip wins):');
{
  const blocks = AXEFX3_DESCRIPTOR.blocks;
  // KIND conflicts: cache float row, roundtrip says discrete. Sample the
  // conflict list across families (full list in the generator output).
  const kindConflictSamples: ReadonlyArray<readonly [string, string, number]> = [
    ['reverb', 'basetype', 8],
    ['delay', 'bitreduce', 24],
    ['pitch', 'customscale1', 31],
    ['chorus', 'voices', 4],
    ['filter', 'aporder', 12],
  ];
  for (const [slug, key, maxOrd] of kindConflictSamples) {
    const s = blocks[slug]?.params[key];
    const routedDiscrete = s?.wire_kind === 'discrete';
    let acceptsMax = false;
    let rejectsOver = false;
    try { acceptsMax = s?.encode(maxOrd) === maxOrd; } catch { acceptsMax = false; }
    try { s?.encode(maxOrd + 1); } catch { rejectsOver = true; }
    check(`${slug}.${key} routed DISCRETE with roundtrip bound ${maxOrd} (cache float row overruled)`,
      routedDiscrete === true && acceptsMax && rejectsOver,
      `wire_kind=${s?.wire_kind} encode(${maxOrd}) ok=${acceptsMax} encode(${maxOrd + 1}) rejected=${rejectsOver}`);
  }
  // ORDINAL-BOUND conflict: DELAY_SVFTYPE cache enumCount 3 vs roundtrip
  // maxOrdinal 3; the device stores ordinal 3, so encode must accept it.
  const svf = blocks['delay']?.params['svftype'];
  check('delay.svftype ordinal bound = roundtrip 3 (cache enumCount 3 would refuse ordinal 3)',
    svf?.wire_kind === 'discrete' && svf?.encode(3) === 3 && III_ROUNDTRIP_DISCRETE['DELAY_SVFTYPE'] === 3,
    `wire_kind=${svf?.wire_kind} encode(3)=${(() => { try { return svf?.encode(3); } catch (e) { return 'THROW'; } })()}`);
  // A roundtrip-discrete param with a cache float row must NOT advertise the
  // cache float window as display bounds (mod.endpt cache float 0..100 vs
  // roundtrip maxOrdinal 78).
  const endpt = blocks['scene_midi']?.params['endpt'] ?? blocks['mod']?.params['endpt'];
  if (endpt !== undefined) {
    check('MOD_ENDPT does not advertise the overruled cache float window 0..100',
      !(endpt.display_min === 0 && endpt.display_max === 100 && endpt.wire_kind === 'discrete'),
      `unit=${endpt.unit} wire_kind=${endpt.wire_kind} bounds ${endpt.display_min}..${endpt.display_max}`);
  }
  // Wiring sanity: the device-true window reaches the schema (silent-wrong-
  // write killer: 12000 ms is VALID on the III delay, invalid under the
  // AM4-inherited 0..8000).
  const dtime = blocks['delay']?.params['time'];
  check('delay.time accepts 12000 ms (device-true 16 s ceiling reaches encode)',
    typeof dtime?.encode(12000) === 'number', 'encode(12000) threw');
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
  for (const [family, meta] of Object.entries(III_RANGE_SECTIONS)) {
    const sec = bySec.get(meta.sectionTag);
    for (const [idStr, g] of Object.entries(III_RANGES[family] ?? {})) {
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
  console.error(`\nverify-iii-ranges: ${failed} check(s) FAILED`);
  process.exit(1);
}
console.log('\nverify-iii-ranges: all checks passed (device-true ranges, anchors + strides + spot panel + conflict rule valid)');
