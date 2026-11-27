// review scratch: params the change made UNDER-print vs the typecode-nibble predictor (fixed-2 did not)
import { AXEFX3_DESCRIPTOR, FM3_DESCRIPTOR, FM9_DESCRIPTOR } from '@mcp-midi-control/fractal-gen3/device.js';
import { FM9_RANGES, FM9_PARAMS_BY_FAMILY } from 'fractal-midi/gen3/fm9';
import { FM3_RANGES, FM3_PARAMS_BY_FAMILY } from 'fractal-midi/gen3/fm3';
import { III_RANGES, PARAMS_BY_FAMILY } from 'fractal-midi/gen3/axe-fx-iii';
import { DEVICE_LABEL_CALIBRATION } from 'fractal-midi/gen2/axe-fx-ii';
const decOf = (x: number) => { for (let d = 0; d <= 6; d++) if (Math.abs(Math.round(x * 10 ** d) - x * 10 ** d) < 1e-7 * Math.max(1, 10 ** d)) return d; return 7; };
for (const [id, d, R, F] of [['iii', AXEFX3_DESCRIPTOR, III_RANGES, PARAMS_BY_FAMILY], ['fm3', FM3_DESCRIPTOR, FM3_RANGES, FM3_PARAMS_BY_FAMILY], ['fm9', FM9_DESCRIPTOR, FM9_RANGES, FM9_PARAMS_BY_FAMILY]] as const) {
  const row = new Map<string, any>();
  for (const [fam, ps] of Object.entries(F as any)) for (const p of ps as any[]) { const r = (R as any)[fam]?.[p.paramId]; if (r) row.set(p.name, r); }
  const out: string[] = []; let fixedByChange = 0;
  for (const [slug, b] of Object.entries(d.blocks)) for (const [pn, s] of Object.entries(b.params) as any) {
    if (s.wire_kind !== 'continuous' || s.display_min === undefined || s.enum_values) continue;
    try { s.encode(s.display_min); } catch { continue; }
    const r = row.get(s.parameter_name); if (!r || r.kind !== 'float' || r.typecode === undefined || (r.typecode & 0xff) === 0x52) continue;
    let m = 0; for (let w = 0; w <= 65534; w += 97) { const v = s.decode(w); if (typeof v === 'number') m = Math.max(m, decOf(v)); }
    const nib = r.typecode & 0xf; if (nib > 3) continue;
    if (m < nib && nib <= 2) { const ii = DEVICE_LABEL_CALIBRATION[`${slug}.${pn}`]; out.push(`${slug}.${pn}[${s.display_min}..${s.display_max} ${s.unit}] ${m}dp, tc 0x${r.typecode.toString(16)}, step*scale ${+(r.step * r.scale).toPrecision(4)}${ii ? ', II prints ' + ii.decimals : ''}`); }
    if (m === nib && nib === 3 && m !== 2) fixedByChange++;
  }
  console.log(`${id}: newly under-printed vs typecode nibble: ${out.length}; newly 3 dp matching nibble 3: ${fixedByChange}`);
  for (const o of out) console.log('   ' + o);
}
