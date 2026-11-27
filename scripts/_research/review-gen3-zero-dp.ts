// review scratch: every gen-3 row the FINAL rule prints at 0 dp, with window, typecode, step*scale, II and the AM4-overlay unit
import { AXEFX3_DESCRIPTOR, FM9_DESCRIPTOR } from '@mcp-midi-control/fractal-gen3/device.js';
import { devicePrintDecimals } from '@mcp-midi-control/fractal-gen3/catalog.js';
import { FM9_RANGES, FM9_PARAMS_BY_FAMILY } from 'fractal-midi/gen3/fm9';
import { III_RANGES, PARAMS_BY_FAMILY } from 'fractal-midi/gen3/axe-fx-iii';
import { DEVICE_LABEL_CALIBRATION } from 'fractal-midi/gen2/axe-fx-ii';
for (const [id, d, R, F] of [['iii', AXEFX3_DESCRIPTOR, III_RANGES, PARAMS_BY_FAMILY], ['fm9', FM9_DESCRIPTOR, FM9_RANGES, FM9_PARAMS_BY_FAMILY]] as const) {
  const row = new Map<string, any>();
  for (const [fam, ps] of Object.entries(F as any)) for (const p of ps as any[]) { const r = (R as any)[fam]?.[p.paramId]; if (r) row.set(p.name, r); }
  const by: Record<string, string[]> = {};
  for (const [slug, b] of Object.entries(d.blocks)) for (const [pn, s] of Object.entries(b.params) as any) {
    if (s.wire_kind !== 'continuous' || s.display_min === undefined || s.enum_values) continue;
    try { s.encode(s.display_min); } catch { continue; }
    const r = row.get(s.parameter_name); if (!r || r.kind !== 'float' || r.typecode === undefined) continue;
    if (devicePrintDecimals(r) !== 0) continue;
    const ii = DEVICE_LABEL_CALIBRATION[`${slug}.${pn}`];
    (by[`0x${r.typecode.toString(16)}`] ??= []).push(`${slug}.${pn}[${s.display_min}..${s.display_max} ${s.unit} inc ${+(r.step * r.scale).toPrecision(3)}${ii ? ' II' + ii.decimals : ''}]`);
  }
  console.log(`\n${id}:`); for (const [k, v] of Object.entries(by)) console.log(`  ${k} (${v.length}): ${v.join(' ')}`);
}
