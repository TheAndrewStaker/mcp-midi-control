// review scratch: list gen-3 params by shipped effective decimals (0 and 3), with ranges
import { AXEFX3_DESCRIPTOR } from '@mcp-midi-control/fractal-gen3/device.js';
import { DEVICE_LABEL_CALIBRATION } from 'fractal-midi/gen2/axe-fx-ii';
const decOf = (x: number) => { for (let d = 0; d <= 6; d++) if (Math.abs(Math.round(x * 10 ** d) - x * 10 ** d) < 1e-7 * Math.max(1, 10 ** d)) return d; return 7; };
const out: Record<number, string[]> = {};
for (const [slug, b] of Object.entries(AXEFX3_DESCRIPTOR.blocks)) for (const [n, s] of Object.entries(b.params) as any) {
  if (s.wire_kind !== 'continuous' || s.display_min === undefined || s.enum_values) continue;
  try { s.encode(s.display_min); } catch { continue; }
  let m = 0; for (let w = 0; w <= 65534; w += 97) { const v = s.decode(w); if (typeof v === 'number') m = Math.max(m, decOf(v)); }
  const ii = DEVICE_LABEL_CALIBRATION[`${slug}.${n}`];
  (out[m] ??= []).push(`${slug}.${n}[${s.display_min}..${s.display_max} ${s.unit}${ii ? ' II=' + ii.decimals : ''}]`);
}
for (const k of [0, 1, 3]) console.log(`\n${k} dp (${out[k]?.length}):`, (out[k] ?? []).join(' '));
