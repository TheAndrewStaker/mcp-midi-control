/**
 * review-gen3-final-rule.ts (review scratch, read-only): the FINAL rule on the
 * gen-3 catalogs. (a) params now printing < 2 dp with any evidence the panel
 * prints more (II name join, II same-typecode class, PR #24 text); (b) every
 * row the <10-steps guard sends back to 2, and rows it lets through with few
 * steps (< 40); (c) typecode classes with nibble 0 and no step override.
 */
import { AXEFX3_DESCRIPTOR, FM3_DESCRIPTOR, FM9_DESCRIPTOR } from '@mcp-midi-control/fractal-gen3/device.js';
import { devicePrintDecimals } from '@mcp-midi-control/fractal-gen3/catalog.js';
import { FM9_RANGES, FM9_PARAMS_BY_FAMILY } from 'fractal-midi/gen3/fm9';
import { FM3_RANGES, FM3_PARAMS_BY_FAMILY } from 'fractal-midi/gen3/fm3';
import { III_RANGES, PARAMS_BY_FAMILY } from 'fractal-midi/gen3/axe-fx-iii';
import { DEVICE_LABEL_CALIBRATION } from 'fractal-midi/gen2/axe-fx-ii';
const decOf = (x: number) => { for (let d = 0; d <= 6; d++) if (Math.abs(Math.round(x * 10 ** d) - x * 10 ** d) < 1e-7 * Math.max(1, 10 ** d)) return d; return 7; };
// II typecodes that print MORE than their nibble, in-device (from review-ii-final-rule: none after the step override; chorus.mix 0x570 before it)
for (const [id, d, R, F] of [['iii', AXEFX3_DESCRIPTOR, III_RANGES, PARAMS_BY_FAMILY], ['fm3', FM3_DESCRIPTOR, FM3_RANGES, FM3_PARAMS_BY_FAMILY], ['fm9', FM9_DESCRIPTOR, FM9_RANGES, FM9_PARAMS_BY_FAMILY]] as const) {
  const row = new Map<string, any>();
  for (const [fam, ps] of Object.entries(F as any)) for (const p of ps as any[]) { const r = (R as any)[fam]?.[p.paramId]; if (r) row.set(p.name, r); }
  const lessWithEvidence: string[] = []; const guardFired: string[] = []; const thin: string[] = []; const nib0: Record<string, number> = {};
  let fewer = 0, more = 0;
  for (const [slug, b] of Object.entries(d.blocks)) for (const [pn, s] of Object.entries(b.params) as any) {
    if (s.wire_kind !== 'continuous' || s.display_min === undefined || s.enum_values) continue;
    try { s.encode(s.display_min); } catch { continue; }
    const r = row.get(s.parameter_name);
    let m = 0; for (let w = 0; w <= 65534; w += 97) { const v = s.decode(w); if (typeof v === 'number') m = Math.max(m, decOf(v)); }
    if (m < 2) fewer++; if (m > 2) more++;
    const ii = DEVICE_LABEL_CALIBRATION[`${slug}.${pn}`];
    if (m < 2 && ii && !ii.sigFigs && ii.decimals > m) lessWithEvidence.push(`${slug}.${pn} ${m}dp < II ${ii.decimals}`);
    if (!r || r.kind !== 'float' || r.typecode === undefined || (r.typecode & 0xff) === 0x52) continue;
    const nib = Math.min(3, r.typecode & 0xf); const dd = devicePrintDecimals(r);
    const span = Math.abs(r.displayMax - r.displayMin);
    const pre = (() => { let x = nib; const inc = r.step * r.scale; if (inc > 0) { const e = Math.log10(inc), sd = -Math.round(e); if (Math.abs(e + sd) < 1e-9 && sd > x && sd <= 3) x = sd; } return x; })();
    if (dd === 2 && pre !== 2) guardFired.push(`${slug}.${pn}[${r.displayMin}..${r.displayMax} ${s.unit}] tc 0x${r.typecode.toString(16)} would be ${pre}dp${ii ? ' II ' + ii.decimals : ''}`);
    else if (span * 10 ** dd < 40) thin.push(`${slug}.${pn}[${r.displayMin}..${r.displayMax} ${s.unit}] ${dd}dp = ${Math.round(span * 10 ** dd)} steps, tc 0x${r.typecode.toString(16)}${ii ? ' II ' + ii.decimals : ''}`);
    if (dd === 0) nib0[`0x${r.typecode.toString(16)}`] = (nib0[`0x${r.typecode.toString(16)}`] ?? 0) + 1;
  }
  console.log(`\n${id}: effective < 2 dp ${fewer}, > 2 dp ${more}`);
  console.log(`  fewer than before AND II-joined counterpart prints more: ${lessWithEvidence.length} ${lessWithEvidence.join('; ')}`);
  console.log(`  guard sent back to 2 (${guardFired.length}): ${guardFired.join('; ')}`);
  console.log(`  let through with < 40 printed steps (${thin.length}): ${thin.join('; ')}`);
  console.log(`  0-dp rows by typecode: ${JSON.stringify(nib0)}`);
}
