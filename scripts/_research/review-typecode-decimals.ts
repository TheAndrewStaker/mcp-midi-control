/**
 * review-typecode-decimals.ts (review scratch, read-only): is the editor-cache
 * typecode's low nibble the printed-decimals field? Tested in-device on the
 * Axe-Fx II (cache record joined by section+paramId vs the II's own printed
 * decimals), then on gen-3 rows against the II proxy and the PR #24 FM3 panel.
 */
import { readFileSync } from 'node:fs';
import { DEVICE_LABEL_CALIBRATION, KNOWN_PARAMS } from 'fractal-midi/gen2/axe-fx-ii';
import { AXEFX3_DESCRIPTOR, FM3_DESCRIPTOR, FM9_DESCRIPTOR } from '@mcp-midi-control/fractal-gen3/device.js';
import { FM9_RANGES, FM9_PARAMS_BY_FAMILY } from 'fractal-midi/gen3/fm9';
import { FM3_RANGES, FM3_PARAMS_BY_FAMILY } from 'fractal-midi/gen3/fm3';
import { III_RANGES, PARAMS_BY_FAMILY } from 'fractal-midi/gen3/axe-fx-iii';

const walk = JSON.parse(readFileSync('samples/captured/local-caches-2026-06-09/effectDefinitions_07.walk.json', 'utf8')) as { records: Array<{ kind: string; section: number; id: number; tc: number; def: number; step: number }> };
const rec = new Map(walk.records.map((r) => [`${r.section}:${r.id}`, r]));
const P = new Map(Object.values(KNOWN_PARAMS as Record<string, { block: string; name: string; paramId: number }>).map((p) => [`${p.block}.${p.name}`, p]));
const votes = new Map<string, Map<number, number>>();
for (const [k, c] of Object.entries(DEVICE_LABEL_CALIBRATION)) { const m = /^cache\/s(\d+)$/.exec(c.from); if (!m) continue; const b = k.split('.')[0]; const v = votes.get(b) ?? new Map(); v.set(+m[1], (v.get(+m[1]) ?? 0) + 1); votes.set(b, v); }
const secOf = new Map([...votes].map(([b, v]) => [b, [...v].sort((a, z) => z[1] - a[1])[0][0]]));
const conf: Record<string, number> = {}; let n = 0, ok = 0; const miss: string[] = [];
for (const [k, c] of Object.entries(DEVICE_LABEL_CALIBRATION)) {
  if (c.sigFigs || c.factor !== undefined || c.scale === 'ordinal') continue;
  const p = P.get(k); const s = secOf.get(k.split('.')[0]); if (!p || s === undefined) continue;
  const r = rec.get(`${s}:${p.paramId}`); if (!r || r.kind !== 'float') continue;
  const nib = r.tc & 0xf; n++; if (nib === c.decimals) ok++; else if (miss.length < 40) miss.push(`${k} tc 0x${r.tc.toString(16)} II ${c.decimals}`);
  conf[`nib${nib}->II${c.decimals}`] = (conf[`nib${nib}->II${c.decimals}`] ?? 0) + 1;
}
console.log(`II in-device: typecode low nibble == printed decimals on ${ok}/${n}`);
console.log('  confusion: ' + JSON.stringify(Object.fromEntries(Object.entries(conf).sort())));
console.log('  misses: ' + miss.join('; '));

for (const [id, d, R, F] of [['iii', AXEFX3_DESCRIPTOR, III_RANGES, PARAMS_BY_FAMILY], ['fm3', FM3_DESCRIPTOR, FM3_RANGES, FM3_PARAMS_BY_FAMILY], ['fm9', FM9_DESCRIPTOR, FM9_RANGES, FM9_PARAMS_BY_FAMILY]] as const) {
  const row = new Map<string, any>();
  for (const [fam, ps] of Object.entries(F as any)) for (const p of ps as any[]) { const r = (R as any)[fam]?.[p.paramId]; if (r) row.set(p.name, r); }
  let j = 0, nibOk = 0; const cf: Record<string, number> = {};
  for (const [slug, b] of Object.entries(d.blocks)) for (const [pn, s] of Object.entries(b.params) as any) {
    if (s.wire_kind !== 'continuous' || s.display_min === undefined || s.enum_values) continue;
    const c = DEVICE_LABEL_CALIBRATION[`${slug}.${pn}`]; if (!c || c.sigFigs || c.factor !== undefined) continue;
    const r = row.get(s.parameter_name); if (!r || r.kind !== 'float' || r.typecode === undefined) continue;
    j++; const nib = r.typecode & 0xf; if (nib === c.decimals) nibOk++;
    cf[`nib${nib}->II${c.decimals}`] = (cf[`nib${nib}->II${c.decimals}`] ?? 0) + 1;
  }
  console.log(`${id}: typecode nibble == II decimals on ${nibOk}/${j}  ${JSON.stringify(Object.fromEntries(Object.entries(cf).sort()))}`);
}
// PR #24 FM3 panel readings
const fm3row = new Map<string, any>(); for (const [fam, ps] of Object.entries(FM3_PARAMS_BY_FAMILY as any)) for (const p of ps as any[]) { const r = (FM3_RANGES as any)[fam]?.[p.paramId]; if (r) fm3row.set(p.name, r); }
for (const [nm, panel] of [['DISTORT_TRIM', '1.000'], ['PHASER_RATE', '0.35'], ['CHORUS_RATE', '0.5'], ['DELAY_TIME', '300'], ['PEQ_FREQ1', '90']]) {
  const r = fm3row.get(nm); console.log(`FM3 ${nm} panel "${panel}": typecode 0x${r?.typecode?.toString(16)} nibble ${r ? r.typecode & 0xf : '?'}, step ${r?.step} scale ${r?.scale}`);
}
