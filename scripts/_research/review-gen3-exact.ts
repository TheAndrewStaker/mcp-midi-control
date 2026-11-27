// review scratch: exact-decimals agreement with the II, shipped rule vs fixed 2, per device; lists "same distance but still wrong"
import { AXEFX3_DESCRIPTOR, FM3_DESCRIPTOR, FM9_DESCRIPTOR } from '@mcp-midi-control/fractal-gen3/device.js';
import { DEVICE_LABEL_CALIBRATION } from 'fractal-midi/gen2/axe-fx-ii';
const decOf = (x: number) => { for (let d = 0; d <= 6; d++) if (Math.abs(Math.round(x * 10 ** d) - x * 10 ** d) < 1e-7 * Math.max(1, 10 ** d)) return d; return 7; };
for (const [id, d] of [['iii', AXEFX3_DESCRIPTOR], ['fm3', FM3_DESCRIPTOR], ['fm9', FM9_DESCRIPTOR]] as const) {
  let n = 0, newOk = 0, oldOk = 0; const sideways: string[] = []; const stillWrong: Record<string, number> = {};
  for (const [slug, b] of Object.entries(d.blocks)) for (const [p, s] of Object.entries(b.params) as any) {
    if (s.wire_kind !== 'continuous' || s.display_min === undefined || s.enum_values) continue;
    try { s.encode(s.display_min); } catch { continue; }
    const ii = DEVICE_LABEL_CALIBRATION[`${slug}.${p}`]; if (!ii || ii.sigFigs || ii.factor !== undefined) continue;
    let m = 0; for (let w = 0; w <= 65534; w += 97) { const v = s.decode(w); if (typeof v === 'number') m = Math.max(m, decOf(v)); }
    n++; if (m === ii.decimals) newOk++; if (ii.decimals === 2) oldOk++;
    if (m !== 2 && m !== ii.decimals) sideways.push(`${slug}.${p} ${m} vs II ${ii.decimals}`);
    if (m !== ii.decimals) { const k = `rule ${m} / II ${ii.decimals}`; stillWrong[k] = (stillWrong[k] ?? 0) + 1; }
  }
  console.log(`${id}: joined ${n}; exact-decimals agreement: shipped ${newOk}, fixed-2 ${oldOk}; changed-but-still-wrong: ${sideways.join('; ') || 'none'}`);
  console.log('   remaining disagreements: ' + JSON.stringify(stillWrong));
}
