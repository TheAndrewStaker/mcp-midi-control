/**
 * review-gen3-print-decimals.ts (review scratch, read-only): measure the
 * SHIPPED decode's effective printed decimals per gen-3 continuous param
 * (empirically, from decode() over the whole wire range), then
 *  (a) score it against the Axe-Fx II's measured `decimals`, as the audit does
 *      but on the real code path (incl. the max(bounds) rule);
 *  (b) check the FM3 panel readings cited in community PR #24;
 *  (c) count write->read drift: a 2-dp request that no longer reads back.
 */
import { AXEFX3_DESCRIPTOR, FM3_DESCRIPTOR, FM9_DESCRIPTOR } from '@mcp-midi-control/fractal-gen3/device.js';
import { DEVICE_LABEL_CALIBRATION } from 'fractal-midi/gen2/axe-fx-ii';

const decOf = (x: number) => { for (let d = 0; d <= 6; d++) if (Math.abs(Math.round(x * 10 ** d) - x * 10 ** d) < 1e-7 * Math.max(1, 10 ** d)) return d; return 7; };
type S = { wire_kind?: string; display_min?: number; display_max?: number; enum_values?: unknown; unit?: string; parameter_name?: string; decode: (w: number) => unknown; encode: (v: unknown) => unknown };
function eff(s: S): number { let m = 0; for (let w = 0; w <= 65534; w += 97) { const v = s.decode(w); if (typeof v === 'number') m = Math.max(m, decOf(v)); } return m; }

const devs = [['axe-fx-iii', AXEFX3_DESCRIPTOR], ['fm3', FM3_DESCRIPTOR], ['fm9', FM9_DESCRIPTOR]] as const;
for (const [id, d] of devs) {
  const hist: Record<number, number> = {}; let closer = 0, same = 0, further = 0; const fur: string[] = []; const clo: string[] = [];
  let drift = 0, total = 0; const dex: string[] = [];
  for (const [slug, b] of Object.entries(d.blocks)) for (const [n, s0] of Object.entries(b.params)) {
    const s = s0 as unknown as S;
    if (s.wire_kind !== 'continuous' || s.display_min === undefined || s.enum_values) continue;
    try { s.encode(s.display_min); } catch { continue; }
    const e = eff(s); hist[e] = (hist[e] ?? 0) + 1;
    const cal = DEVICE_LABEL_CALIBRATION[`${slug}.${n}`];
    if (cal && !cal.sigFigs && cal.factor === undefined) {
      const now = Math.abs(Math.min(e, 3) - cal.decimals), old = Math.abs(2 - cal.decimals);
      if (now < old) { closer++; clo.push(`${slug}.${n} ${e} (II ${cal.decimals})`); } else if (now > old) { further++; fur.push(`${slug}.${n} ${e} (II ${cal.decimals})`); } else same++;
    }
    // write a 2-dp value inside the range; does it read back as written?
    if (e < 2) {
      const lo = s.display_min!, hi = s.display_max!; const v = Math.round((lo + (hi - lo) * 0.3737) * 100) / 100;
      total++;
      const back = s.decode(Number(s.encode(v)));
      if (back !== v) { drift++; if (dex.length < 4) dex.push(`${slug}.${n} write ${v} reads ${back}`); }
    }
  }
  console.log(`\n${id}: effective decimals histogram ${JSON.stringify(hist)}`);
  console.log(`  vs II decimals (real code path): closer ${closer}, same ${same}, further ${further}`);
  if (further) console.log('   further: ' + fur.join('; '));
  if (process.argv.includes('-v')) console.log('   closer: ' + clo.join('; '));
  console.log(`  params now < 2 dp: ${total}; a 2-dp write reads back different on ${drift}: ${dex.join('; ')}`);
}

// (b) PR #24 FM3 panel text (fn 01 sub 0x10): input trim 1.000, PEQ 90 Hz,
// delay 300 / 380 ms, chorus 0.5 Hz, phaser 0.35 Hz.
console.log('\nFM3 PR #24 panel readings vs shipped decode (write the panel value, read back):');
const fm3 = FM3_DESCRIPTOR.blocks as Record<string, { params: Record<string, S> }>;
const probes: Array<[string, string, number, string]> = [
  ['amp', 'trim', 1.0, '1.000'], ['amp', 'input_trim', 1.0, '1.000'],
  ['parametric_eq', 'freq1', 90, '90'], ['delay', 'time', 300, '300'], ['delay', 'time', 380, '380'],
  ['chorus', 'rate', 0.5, '0.5'], ['phaser', 'rate', 0.35, '0.35'],
];
for (const [blk, p, v, panel] of probes) {
  const s = fm3[blk]?.params[p];
  if (!s) { console.log(`  ${blk}.${p}: not in catalog`); continue; }
  const back = s.decode(Number(s.encode(v)));
  console.log(`  ${blk}.${p} panel "${panel}" -> read ${back}  (effective dp ${eff(s)}, range ${s.display_min}..${s.display_max}, unit ${s.unit})`);
}
