// review scratch: rows whose cache increment is FINER than the final rule's printed resolution (inc < 10^-d), II in-device + gen-3; plus typecode == 0 rows
import { readFileSync } from 'node:fs';
import { DEVICE_LABEL_CALIBRATION, KNOWN_PARAMS } from 'fractal-midi/gen2/axe-fx-ii';
import { devicePrintDecimals } from '@mcp-midi-control/fractal-gen3/catalog.js';
import { AXEFX3_DESCRIPTOR, FM3_DESCRIPTOR, FM9_DESCRIPTOR } from '@mcp-midi-control/fractal-gen3/device.js';
import { FM9_RANGES, FM9_PARAMS_BY_FAMILY } from 'fractal-midi/gen3/fm9';
import { FM3_RANGES, FM3_PARAMS_BY_FAMILY } from 'fractal-midi/gen3/fm3';
import { III_RANGES, PARAMS_BY_FAMILY } from 'fractal-midi/gen3/axe-fx-iii';
const snap = (x: number) => +x.toPrecision(6);
const walk = JSON.parse(readFileSync('samples/captured/local-caches-2026-06-09/effectDefinitions_07.walk.json', 'utf8')) as { records: any[] };
const rec = new Map(walk.records.map((r) => [`${r.section}:${r.id}`, r]));
const P = new Map(Object.values(KNOWN_PARAMS as Record<string, any>).map((p) => [`${p.block}.${p.name}`, p]));
const votes = new Map<string, Map<number, number>>();
for (const [k, c] of Object.entries(DEVICE_LABEL_CALIBRATION)) { const m = /^cache\/s(\d+)$/.exec(c.from); if (!m) continue; const b = k.split('.')[0]; const v = votes.get(b) ?? new Map(); v.set(+m[1], (v.get(+m[1]) ?? 0) + 1); votes.set(b, v); }
const secOf = new Map([...votes].map(([b, v]) => [b, [...v].sort((a, z) => z[1] - a[1])[0][0]]));
const ii: string[] = []; const tc0: string[] = [];
for (const [k, c] of Object.entries(DEVICE_LABEL_CALIBRATION)) {
  if (c.sigFigs || c.factor !== undefined || c.scale === 'ordinal') continue;
  const p = P.get(k); const s = secOf.get(k.split('.')[0]); if (!p || s === undefined) continue;
  const r0: any = rec.get(`${s}:${p.paramId}`); if (!r0 || r0.kind !== 'float') continue;
  const r = { kind: 'float' as const, displayMin: snap(r0.min * r0.def), displayMax: snap(r0.max * r0.def), scale: r0.def, step: snap(r0.step), typecode: r0.tc };
  const d = devicePrintDecimals(r); const inc = snap(r0.step * r0.def);
  if (inc > 0 && inc < 10 ** -d - 1e-12) ii.push(`${k} inc ${inc} rule ${d} II ${c.decimals} tc 0x${r0.tc.toString(16)}`);
  if (r0.tc === 0) tc0.push(`${k} rule ${d} II ${c.decimals}`);
}
console.log(`II in-device: inc finer than printed resolution: ${ii.length}`); for (const x of ii) console.log('   ' + x);
console.log(`II typecode == 0 rows: ${tc0.length} ${tc0.join('; ')}`);
for (const [id, d, R, F] of [['iii', AXEFX3_DESCRIPTOR, III_RANGES, PARAMS_BY_FAMILY], ['fm3', FM3_DESCRIPTOR, FM3_RANGES, FM3_PARAMS_BY_FAMILY], ['fm9', FM9_DESCRIPTOR, FM9_RANGES, FM9_PARAMS_BY_FAMILY]] as const) {
  const row = new Map<string, any>(); for (const [fam, ps] of Object.entries(F as any)) for (const p of ps as any[]) { const r = (R as any)[fam]?.[p.paramId]; if (r) row.set(p.name, r); }
  const out: string[] = []; const z: string[] = [];
  for (const [slug, b] of Object.entries(d.blocks)) for (const [pn, s] of Object.entries(b.params) as any) {
    if (s.wire_kind !== 'continuous' || s.display_min === undefined || s.enum_values) continue;
    try { s.encode(s.display_min); } catch { continue; }
    const r = row.get(s.parameter_name); if (!r || r.kind !== 'float' || r.typecode === undefined || (r.typecode & 0xff) === 0x52) continue;
    const dd = devicePrintDecimals(r); const inc = r.step * r.scale;
    if (inc > 0 && inc < 10 ** -dd - 1e-12 && dd < 2) out.push(`${slug}.${pn}[${r.displayMin}..${r.displayMax}] inc ${+inc.toPrecision(3)} -> ${dd}dp tc 0x${r.typecode.toString(16)}`);
    if (r.typecode === 0) z.push(`${slug}.${pn}[${r.displayMin}..${r.displayMax}] -> ${dd}dp`);
  }
  console.log(`${id}: below-2-dp rows whose increment is finer than the print: ${out.length} ${out.join('; ')}`);
  console.log(`   typecode 0 rows: ${z.join('; ')}`);
}
