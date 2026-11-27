/**
 * verify-ii-device-labels.ts: the Axe-Fx II display calibration must print
 * what the device itself prints.
 *
 * Fixture: scripts/fixtures/ii-device-labels.json, distinct (wire, label)
 * pairs per param read off a real Axe-Fx II XL+ (Ares 2.00) on 2026-11-26: the
 * label is the device's own display text from the fn 0x02 GET reply, which is
 * identical to Axe-Edit's (read-only sweep of every stored preset, plus
 * write-and-restore probes for params the presets never varied).
 * Regenerate: scripts/_research/ii-label-sweep.ts / ii-label-probe.ts, then
 * `npx tsx scripts/verify-ii-device-labels.ts --write-fixture <a.jsonl,b.jsonl>`.
 *
 * Fails when:
 *   - a device-label calibration entry or roster misses ANY fixture sample
 *     for its param (value, set_param round-trip, or unit);
 *   - a catalog-wide total (wrong values, wrong round-trips, wrong units,
 *     wrong enum labels, uncalibrated raw-wire samples) rises above its frozen
 *     ceiling. A total that falls prints a note: tighten the ceiling.
 */
import { readFileSync, writeFileSync } from 'node:fs';

import { DEVICE_LABEL_CALIBRATION, DEVICE_LABEL_ENUMS } from 'fractal-midi/gen2/axe-fx-ii';

import { AXEFX2_DESCRIPTOR } from '@mcp-midi-control/fractal-gen2/descriptor.js';

import { samplesFromJsonl, scoreLabels, kindFromDescriptor, type LabelSample, type LabelScore } from './_lib/ii-label-score.js';

const FIXTURE = 'scripts/fixtures/ii-device-labels.json';

if (process.argv[2] === '--write-fixture') {
  const samples = samplesFromJsonl(process.argv[3].split(',').map((f) => readFileSync(f, 'utf8')).join('\n'));
  const byKey: Record<string, Array<[number, string]>> = {};
  for (const s of samples) (byKey[s.key] ??= []).push([s.wire, s.label]);
  const sorted = Object.fromEntries(Object.keys(byKey).sort().map((k) => [k, byKey[k].sort((a, b) => a[0] - b[0])]));
  const residue = residueOf(scoreLabels(samples));
  writeFileSync(FIXTURE, JSON.stringify({ device: 'Axe-Fx II XL+', firmware: 'Ares 2.00', captured: '2026-11-26', residue, samples: sorted }) + '\n');
  console.log(`residue frozen: ${Object.keys(residue).length} calibrated params miss ${Object.values(residue).reduce((n, r) => n + r.value, 0)} readings by one printed step`);
  console.log(`${samples.length} samples over ${Object.keys(sorted).length} params -> ${FIXTURE}`);
  process.exit(0);
}

/**
 * Frozen catalog-wide ceilings over the fixture. Lower them when a fix lands;
 * never raise to go green. Shipped decode before the device-label table, same
 * fixture and exact scorer: valueBad 2396, writeBad 1333, enumBad 401,
 * unitMismatch 124 params, opaque 1968. After: 548 params better; 2 formerly
 * raw-wire params now read but carry one write residue each.
 */
const CEILINGS = {
  valueBad: 129,
  writeBad: 35,
  enumBad: 16,
  unitMismatch: 1,
  opaque: 417,
} as const;

/**
 * Per-param residue, frozen in the fixture: readings a calibrated param prints
 * one step off the panel ("10.04" where the panel shows "10.03"). No model
 * and print rule reproduces them, including other wire denominators: the
 * device's own arithmetic differs in the 5th significant figure. The fitter
 * only accepts an entry that prints at least as many readings as the decode it
 * replaced, and this freezes that: a param may never miss MORE than its
 * frozen residue.
 */
type Residue = Record<string, { value: number; write: number }>;
function residueOf(score: LabelScore): Residue {
  const out: Residue = {};
  for (const key of [...Object.keys(DEVICE_LABEL_CALIBRATION), ...Object.keys(DEVICE_LABEL_ENUMS)].sort()) {
    const st = score.perKey.get(key);
    if (st && (st.n - st.ok > 0 || st.writeBad > 0)) out[key] = { value: st.n - st.ok, write: st.writeBad };
  }
  return out;
}

const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8')) as { residue?: Residue; samples: Record<string, Array<[number, string]>> };
const RESIDUE: Residue = fixture.residue ?? {};
const samples: LabelSample[] = Object.entries(fixture.samples).flatMap(([key, rows]) => rows.map(([wire, label]) => ({ key, wire, label })));
const score = scoreLabels(samples);

let failures = 0;
const fail = (msg: string) => { failures++; console.error(`  FAIL  ${msg}`); };

for (const key of [...Object.keys(DEVICE_LABEL_CALIBRATION), ...Object.keys(DEVICE_LABEL_ENUMS)]) {
  const st = score.perKey.get(key);
  if (!st) { fail(`${key}: calibrated from device labels but has no fixture samples`); continue; }
  const allowed = RESIDUE[key] ?? { value: 0, write: 0 };
  if (st.n - st.ok < allowed.value || st.writeBad < allowed.write) console.log(`  note  ${key}: fewer misses than its frozen residue: re-freeze with --write-fixture`);
  if (st.n - st.ok > allowed.value) fail(`${key}: ${st.n - st.ok}/${st.n} fixture labels not reproduced: ${st.bad.slice(0, 3).join('; ')}`);
  if (st.writeBad > allowed.write) fail(`${key}: ${st.writeBad} label readings do not survive encode -> decode`);
  if (!st.unitOk) fail(`${key}: unit ${st.unit} but the device prints "${st.labelUnit}"`);
}

// The tool surface (descriptor schemas: what get_param / set_param run) must
// score exactly as the calibration resolver does, param by param; otherwise
// this gate is checking a path the tools do not take.
{
  const surface = scoreLabels(samples, kindFromDescriptor(AXEFX2_DESCRIPTOR, new Set(['resonator.freq', 'resonator.freq1', 'resonator.freq2', 'resonator.freq3', 'resonator.freq4'])));
  for (const [key, st] of score.perKey) {
    const t = surface.perKey.get(key)!;
    if (st.ok !== t.ok || st.writeBad !== t.writeBad || st.unitOk !== t.unitOk) {
      fail(`${key}: the descriptor schema scores ${t.ok}/${t.n} (write misses ${t.writeBad}) but the calibration resolver ${st.ok}/${st.n} (${st.writeBad})`);
    }
  }
}

const totals = { valueBad: score.valueBad, writeBad: score.writeBad, enumBad: score.enumBad, unitMismatch: score.unitMismatch, opaque: score.opaque };
for (const [k, ceiling] of Object.entries(CEILINGS) as Array<[keyof typeof CEILINGS, number]>) {
  if (totals[k] > ceiling) fail(`${k} ${totals[k]} > ceiling ${ceiling} (a decode got worse against the device's own labels)`);
  else if (totals[k] < ceiling) console.log(`  note  ${k} ${totals[k]} < ceiling ${ceiling}: tighten CEILINGS to freeze the gain`);
}

console.log(`  ${score.samples} device labels over ${score.params} params: value ok ${score.valueOk}, enum ok ${score.enumOk}, `
  + `${Object.keys(DEVICE_LABEL_CALIBRATION).length} device-label calibrations + ${Object.keys(DEVICE_LABEL_ENUMS).length} rosters checked`);
if (failures) {
  console.error(`x verify-ii-device-labels: ${failures} failure(s)`);
  process.exit(1);
}
console.log('OK verify-ii-device-labels: the II calibration prints the device\'s own labels.');
