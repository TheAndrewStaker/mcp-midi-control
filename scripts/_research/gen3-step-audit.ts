/**
 * gen3-step-audit.ts (research, read-only): would per-param print precision
 * from the editor-cache `step` be right? Joins each gen-3 continuous param to
 * its cache row (parameter_name -> family/paramId), derives decimals from the
 * display step (step * scale), and scores that rule against the decimals the
 * Axe-Fx II actually prints for the same (block, name).
 */
import { AXEFX3_DESCRIPTOR, FM3_DESCRIPTOR, FM9_DESCRIPTOR } from '@mcp-midi-control/fractal-gen3/device.js';
import { DEVICE_LABEL_CALIBRATION } from 'fractal-midi/gen2/axe-fx-ii';
import { FM9_RANGES, FM9_PARAMS_BY_FAMILY } from 'fractal-midi/gen3/fm9';
import { FM3_RANGES, FM3_PARAMS_BY_FAMILY } from 'fractal-midi/gen3/fm3';
import { III_RANGES, PARAMS_BY_FAMILY } from 'fractal-midi/gen3/axe-fx-iii';

type Row = { kind: string; scale?: number; step?: number; typecode?: number };
const decOf = (x: number) => { for (let d = 0; d <= 6; d++) if (Math.abs(Math.round(x * 10 ** d) - x * 10 ** d) < 1e-6) return d; return 7; };
const devs = [
  ['axe-fx-iii', AXEFX3_DESCRIPTOR, III_RANGES, PARAMS_BY_FAMILY],
  ['fm3', FM3_DESCRIPTOR, FM3_RANGES, FM3_PARAMS_BY_FAMILY],
  ['fm9', FM9_DESCRIPTOR, FM9_RANGES, FM9_PARAMS_BY_FAMILY],
] as const;
for (const [id, d, ranges, byFam] of devs) {
  const where = new Map<string, Row>();
  for (const [fam, ps] of Object.entries(byFam as Record<string, Array<{ name: string; paramId: number }>>))
    for (const p of ps) { const r = (ranges as Record<string, Record<number, Row>>)[fam]?.[p.paramId]; if (r) where.set(p.name, r); }
  let cont = 0, noStep = 0, over2 = 0, over3 = 0, j = 0, jok = 0; const hist: Record<number, number> = {}; const miss: string[] = []; const big: string[] = [];
  for (const [slug, b] of Object.entries(d.blocks)) for (const [n, s] of Object.entries(b.params)) {
    if (s.wire_kind !== 'continuous' || s.display_min === undefined) continue;
    cont++;
    const r = where.get((s as { parameter_name?: string }).parameter_name ?? '');
    if (!r || r.kind !== 'float' || !r.step || !r.scale || ((r.typecode ?? 0) & 0xff) === 0x52) { noStep++; continue; }
    const ds = r.step * r.scale; const dec = decOf(ds);
    hist[dec] = (hist[dec] ?? 0) + 1;
    if (dec > 2) { over2++; if (big.length < 400) big.push(`${slug}.${n}(${+ds.toPrecision(6)})`); }
    if (dec > 3) over3++;
    const cal = DEVICE_LABEL_CALIBRATION[`${slug}.${n}`];
    if (cal && !cal.sigFigs) { j++; if (Math.min(dec, 3) === cal.decimals) jok++; else miss.push(`${slug}.${n} step ${+ds.toPrecision(6)} -> ${Math.min(dec, 3)} dp, II prints ${cal.decimals}`); }
  }
  console.log(`\n${id}: ${cont} continuous; ${noStep} without a usable step; decimals-from-step histogram ${JSON.stringify(hist)}; >2 dp: ${over2} (>3: ${over3})`);
  console.log(`  vs II printed decimals (same name, fixed-decimals entries): ${jok}/${j} agree`);
  for (const m of miss) console.log('   x ' + m);
  if (process.argv.includes('-v')) console.log('  >2dp: ' + big.join(' '));
}

// Baseline: fixed 2 dp (shipped) vs step rule vs max(2, step), each against II printed decimals.
{
  const [, d, ranges, byFam] = devs[2];
  const where = new Map<string, Row>();
  for (const [fam, ps] of Object.entries(byFam as Record<string, Array<{ name: string; paramId: number }>>))
    for (const p of ps) { const r = (ranges as Record<string, Record<number, Row>>)[fam]?.[p.paramId]; if (r) where.set(p.name, r); }
  const score = { fixed2: 0, step: 0, max2: 0, n: 0 };
  const lost: string[] = [];
  for (const [slug, b] of Object.entries(d.blocks)) for (const [n, s] of Object.entries(b.params)) {
    if (s.wire_kind !== 'continuous') continue;
    const cal = DEVICE_LABEL_CALIBRATION[`${slug}.${n}`];
    if (!cal || cal.sigFigs || cal.factor !== undefined) continue;
    const r = where.get((s as { parameter_name?: string }).parameter_name ?? '');
    const sd = r && r.kind === 'float' && r.step && r.scale && ((r.typecode ?? 0) & 0xff) !== 0x52 ? Math.min(3, decOf(r.step * r.scale)) : 2;
    score.n++;
    if (cal.decimals === 2) score.fixed2++;
    if (sd === cal.decimals) score.step++;
    if (Math.max(2, sd) === cal.decimals) score.max2++;
    if (cal.decimals > 2) lost.push(`${slug}.${n}(${cal.decimals}dp)`);
  }
  console.log(`\nfm9 vs II printed decimals, ${score.n} joined params: fixed 2 dp ${score.fixed2}, step rule ${score.step}, max(2,step) ${score.max2}`);
  console.log(`  II prints 3 dp on: ${lost.join(' ')}`);
}

// Regressions vs shipped: II prints >= 2 dp (fixed 2 dp loses nothing) but the step rule prints fewer.
{
  for (const [id, d, ranges, byFam] of devs) {
    const where = new Map<string, Row>();
    for (const [fam, ps] of Object.entries(byFam as Record<string, Array<{ name: string; paramId: number }>>))
      for (const p of ps) { const r = (ranges as Record<string, Record<number, Row>>)[fam]?.[p.paramId]; if (r) where.set(p.name, r); }
    const worse: string[] = []; const better: string[] = [];
    for (const [slug, b] of Object.entries(d.blocks)) for (const [n, s] of Object.entries(b.params)) {
      if (s.wire_kind !== 'continuous') continue;
      const cal = DEVICE_LABEL_CALIBRATION[`${slug}.${n}`];
      if (!cal || cal.sigFigs || cal.factor !== undefined) continue;
      const r = where.get((s as { parameter_name?: string }).parameter_name ?? '');
      const sd = r && r.kind === 'float' && r.step && r.scale && ((r.typecode ?? 0) & 0xff) !== 0x52 ? Math.min(3, decOf(r.step * r.scale)) : 2;
      const errNow = Math.abs(2 - cal.decimals), errStep = Math.abs(sd - cal.decimals);
      if (errStep > errNow) worse.push(`${slug}.${n} step->${sd} II ${cal.decimals}`);
      if (errStep < errNow) better.push(`${slug}.${n}`);
    }
    console.log(`${id}: step rule closer to the II print on ${better.length}, further on ${worse.length}: ${worse.join('; ')}`);
  }
}

// Variant: step counts only when it is an exact power of ten (1, 0.1, 0.01, 0.001); else 2 dp.
{
  const pow10 = (x: number) => { const l = Math.log10(x); return Math.abs(l - Math.round(l)) < 1e-9 && l <= 0 && l >= -3; };
  for (const [id, d, ranges, byFam] of devs) {
    const where = new Map<string, Row>();
    for (const [fam, ps] of Object.entries(byFam as Record<string, Array<{ name: string; paramId: number }>>))
      for (const p of ps) { const r = (ranges as Record<string, Record<number, Row>>)[fam]?.[p.paramId]; if (r) where.set(p.name, r); }
    const worse: string[] = []; let better = 0, same = 0, changed = 0, total = 0; const hist: Record<number, number> = {};
    for (const [slug, b] of Object.entries(d.blocks)) for (const [n, s] of Object.entries(b.params)) {
      if (s.wire_kind !== 'continuous' || s.display_min === undefined) continue;
      const r = where.get((s as { parameter_name?: string }).parameter_name ?? '');
      const ds = r && r.kind === 'float' && r.step && r.scale && ((r.typecode ?? 0) & 0xff) !== 0x52 ? r.step * r.scale : 0;
      const sd = ds && pow10(ds) ? Math.round(-Math.log10(ds)) : 2;
      total++; if (sd !== 2) changed++; hist[sd] = (hist[sd] ?? 0) + 1;
      const cal = DEVICE_LABEL_CALIBRATION[`${slug}.${n}`];
      if (!cal || cal.sigFigs || cal.factor !== undefined || s.enum_values) continue;
      const errNow = Math.abs(2 - cal.decimals), errStep = Math.abs(sd - cal.decimals);
      if (errStep > errNow) worse.push(`${slug}.${n} ->${sd} II ${cal.decimals}`); else if (errStep < errNow) better++; else same++;
    }
    console.log(`${id}: ${changed}/${total} continuous params change decimals ${JSON.stringify(hist)}; vs II: closer ${better}, same ${same}, further ${worse.length} ${worse.join('; ')}`);
  }
}
