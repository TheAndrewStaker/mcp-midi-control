/**
 * Gate: the generated FM3 device-true display ranges must keep their validated
 * shape — the cache anchors (REVERB_TIME 0.1..100 step 0.02; amp/FUZZ/reverb
 * enum counts 331/86/79), the wire strides (DISTORT 144, REVERB 71, CABINET
 * 106 ordinary records excluding the 4 special cab-table records), and a panel
 * of spot rows read from the device-synced FM3-Edit cache walk at authoring
 * time. A bad regeneration (wrong cache, broken section-to-family vote, scale
 * misapplied) fails here instead of silently shipping wrong ranges.
 *
 * When the source walk JSON is present locally (samples/ is gitignored), every
 * generated row is additionally cross-checked against it; on machines without
 * the capture the hard-coded panel still runs.
 *
 * NOTE: FM3 paramIds are device-specific and differ from the FM9 (e.g. amp/
 * DISTORT type enum is id 6 on FM3 vs id 10 on FM9; REVERB_TYPE is id 0 vs 10).
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FM3_RANGES, FM3_RANGE_SECTIONS, type Fm3ParamRange } from '../packages/fractal-midi/src/gen3/fm3/ranges.generated.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const WALK = resolve(root, 'samples/fm3/effectDefinitions_11_12p0.walk.json');

let failed = 0;
function check(label: string, cond: boolean, detail: string): void {
  if (cond) console.log(`  ok    ${label}`);
  else {
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
  why: string
): void {
  const r = row(family, id);
  const got = r ? `kind=${r.kind} ${r.displayMin}..${r.displayMax} scale=${r.scale} step=${r.step}${r.enumCount !== undefined ? ` enumCount=${r.enumCount}` : ''}` : 'missing';
  const ok =
    !!r && r.kind === exp.kind && r.displayMin === exp.displayMin && r.displayMax === exp.displayMax && r.scale === exp.scale && r.step === exp.step && r.enumCount === exp.enumCount;
  check(`${family}[${id}] ${why}`, ok, `got ${got}`);
}

// ---- cache anchors ----
console.log('anchors:');
checkRow('REVERB', 1, { kind: 'float', displayMin: 0.1, displayMax: 100, scale: 1, step: 0.02 }, 'REVERB_TIME 0.1..100 step 0.02');
check('DISTORT[6] amp enum count = 331', row('DISTORT', 6)?.enumCount === 331, `got ${row('DISTORT', 6)?.enumCount}`);
check('FUZZ[0] drive enum count = 86', row('FUZZ', 0)?.enumCount === 86, `got ${row('FUZZ', 0)?.enumCount}`);
check('REVERB[0] reverb-type enum count = 79', row('REVERB', 0)?.enumCount === 79, `got ${row('REVERB', 0)?.enumCount}`);

// ---- strides / sections ----
console.log('strides / sections:');
check('DISTORT stride = 144', FM3_RANGE_SECTIONS.DISTORT?.stride === 144, `got ${FM3_RANGE_SECTIONS.DISTORT?.stride}`);
check('REVERB stride = 71', FM3_RANGE_SECTIONS.REVERB?.stride === 71, `got ${FM3_RANGE_SECTIONS.REVERB?.stride}`);
check('CABINET wire stride = 106 (ordinary records only)', FM3_RANGE_SECTIONS.CABINET?.stride === 106, `got ${FM3_RANGE_SECTIONS.CABINET?.stride}`);
check('CABINET raw recordCount = 110 (incl. 4 special cab-table records)', FM3_RANGE_SECTIONS.CABINET?.recordCount === 110, `got ${FM3_RANGE_SECTIONS.CABINET?.recordCount}`);
check('every family: stride <= recordCount and stride == emitted row count', Object.entries(FM3_RANGE_SECTIONS).every(([f, m]) => m.stride <= m.recordCount && m.stride === Object.keys(FM3_RANGES[f] ?? {}).length), 'a family has stride > recordCount or stride != emitted row count');
check('INPUT instance sections = 41,42', JSON.stringify(FM3_RANGE_SECTIONS.INPUT?.instanceTags) === '[41,42]', `got ${JSON.stringify(FM3_RANGE_SECTIONS.INPUT?.instanceTags)}`);
check('OUTPUT instance sections = 46,47', JSON.stringify(FM3_RANGE_SECTIONS.OUTPUT?.instanceTags) === '[46,47]', `got ${JSON.stringify(FM3_RANGE_SECTIONS.OUTPUT?.instanceTags)}`);

// ---- spot rows (from the FM3 cache walk) ----
console.log('cache spot rows:');
checkRow('FUZZ', 1, { kind: 'float', displayMin: 0, displayMax: 10, scale: 10, step: 0.001 }, 'FUZZ_DRIVE 0..10');
checkRow('FUZZ', 3, { kind: 'float', displayMin: 0, displayMax: 10, scale: 10, step: 0.001 }, 'FUZZ_LEVEL 0..10');
checkRow('FUZZ', 4, { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001 }, 'FUZZ_MIX 0..100 %');
checkRow('REVERB', 2, { kind: 'float', displayMin: 200, displayMax: 20000, scale: 1, step: 0 }, 'REVERB_HICUT 200..20000 Hz');

// ---- full cross-check against the walk JSON when present ----
if (existsSync(WALK)) {
  const walk = JSON.parse(readFileSync(WALK, 'utf8')) as { records: { kind: string; section: number; id: number; min: number; max: number; def: number; count?: number }[] };
  const bySec = new Map<number, Map<number, (typeof walk.records)[number]>>();
  for (const r of walk.records) {
    if (r.id >= 0xff00) continue;
    let m = bySec.get(r.section);
    if (!m) bySec.set(r.section, (m = new Map()));
    m.set(r.id, r);
  }
  const near = (a: number, b: number) => Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b));
  let rows = 0,
    bad = 0;
  for (const [family, meta] of Object.entries(FM3_RANGE_SECTIONS)) {
    const sec = bySec.get(meta.sectionTag);
    for (const [idStr, g] of Object.entries(FM3_RANGES[family] ?? {})) {
      rows++;
      const r = sec?.get(Number(idStr));
      const scaleOr1 = r && r.def !== 0 ? r.def : 1;
      const ok = !!r && g.kind === r.kind && near(g.displayMin, r.min * scaleOr1) && near(g.displayMax, r.max * scaleOr1) && near(g.scale, r.def) && g.enumCount === r.count;
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
console.log('\nverify-fm3-ranges: all checks passed (device-true ranges, anchors + strides + spot panel valid)');
