// review scratch: shipped effective decimals vs the typecode-nibble predictor, per gen-3 device
import { AXEFX3_DESCRIPTOR, FM3_DESCRIPTOR, FM9_DESCRIPTOR } from '@mcp-midi-control/fractal-gen3/device.js';
import { FM9_RANGES, FM9_PARAMS_BY_FAMILY } from 'fractal-midi/gen3/fm9';
import { FM3_RANGES, FM3_PARAMS_BY_FAMILY } from 'fractal-midi/gen3/fm3';
import { III_RANGES, PARAMS_BY_FAMILY } from 'fractal-midi/gen3/axe-fx-iii';
const decOf = (x: number) => { for (let d = 0; d <= 6; d++) if (Math.abs(Math.round(x * 10 ** d) - x * 10 ** d) < 1e-7 * Math.max(1, 10 ** d)) return d; return 7; };
for (const [id, d, R, F] of [['iii', AXEFX3_DESCRIPTOR, III_RANGES, PARAMS_BY_FAMILY], ['fm3', FM3_DESCRIPTOR, FM3_RANGES, FM3_PARAMS_BY_FAMILY], ['fm9', FM9_DESCRIPTOR, FM9_RANGES, FM9_PARAMS_BY_FAMILY]] as const) {
  const row = new Map<string, any>();
  for (const [fam, ps] of Object.entries(F as any)) for (const p of ps as any[]) { const r = (R as any)[fam]?.[p.paramId]; if (r) row.set(p.name, r); }
  const t = { agree: 0, under: 0, over: 0, oldUnder: 0, oldAgree: 0 }; const und: string[] = [];
  for (const [slug, b] of Object.entries(d.blocks)) for (const [pn, s] of Object.entries(b.params) as any) {
    if (s.wire_kind !== 'continuous' || s.display_min === undefined || s.enum_values) continue;
    try { s.encode(s.display_min); } catch { continue; }
    const r = row.get(s.parameter_name); if (!r || r.kind !== 'float' || r.typecode === undefined || (r.typecode & 0xff) === 0x52) continue;
    let m = 0; for (let w = 0; w <= 65534; w += 97) { const v = s.decode(w); if (typeof v === 'number') m = Math.max(m, decOf(v)); }
    const nib = r.typecode & 0xf; if (nib > 3) continue;
    if (m === nib) t.agree++; else if (m < nib) { t.under++; if (und.length < 30) und.push(`${slug}.${pn}(${m}<${nib})`); } else t.over++;
    if (2 < nib) t.oldUnder++; if (2 === nib) t.oldAgree++;
  }
  console.log(`${id}: shipped vs typecode nibble: agree ${t.agree}, under-prints ${t.under}, over-prints ${t.over} | fixed-2: agree ${t.oldAgree}, under ${t.oldUnder}`);
  console.log('   under: ' + und.join(' '));
}
