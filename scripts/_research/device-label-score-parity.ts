/**
 * device-label-score-parity.ts (research): score the II fixture through the II
 * calibration resolver AND through the II descriptor's schemas (the tool
 * surface). The two must agree; a gap means get_param / set_param do not run
 * the calibration the gate checks.
 */
import { readFileSync } from 'node:fs';
import { AXEFX2_DESCRIPTOR } from '@mcp-midi-control/fractal-gen2/descriptor.js';
import { scoreLabels, iiKind, kindFromDescriptor, type LabelSample } from '../_lib/ii-label-score.js';

const fx = JSON.parse(readFileSync('scripts/fixtures/ii-device-labels.json', 'utf8')) as { samples: Record<string, Array<[number, string]>> };
const samples: LabelSample[] = Object.entries(fx.samples).flatMap(([key, rows]) => rows.map(([wire, label]) => ({ key, wire, label })));
const pick = (s: ReturnType<typeof scoreLabels>) => ({ valueOk: s.valueOk, valueBad: s.valueBad, enumOk: s.enumOk, enumBad: s.enumBad, writeBad: s.writeBad, opaque: s.opaque, unitMismatch: s.unitMismatch });
const a = scoreLabels(samples, iiKind), b = scoreLabels(samples, kindFromDescriptor(AXEFX2_DESCRIPTOR, new Set(['resonator.freq', 'resonator.freq1', 'resonator.freq2', 'resonator.freq3', 'resonator.freq4'])));
console.log('resolver  ', pick(a)); console.log('descriptor', pick(b));
let diff = 0;
for (const [k, x] of a.perKey) { const y = b.perKey.get(k)!; if (x.ok !== y.ok || x.writeBad !== y.writeBad || x.unitOk !== y.unitOk) { diff++; if (diff <= 10) console.log(`  ${k}: resolver ok ${x.ok}/${x.n} wb ${x.writeBad} unit ${x.unit} | descriptor ok ${y.ok}/${y.n} wb ${y.writeBad} unit ${y.unit} ${y.bad.slice(0, 2).join('; ')}`); } }
console.log(`${diff} params score differently`);
