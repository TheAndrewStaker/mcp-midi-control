/** gen3-nibble-coarse.ts (research): calibrated continuous params whose print decimals leave < 20 distinct readings. */
import { AXEFX3_DESCRIPTOR, FM3_DESCRIPTOR, FM9_DESCRIPTOR } from '@mcp-midi-control/fractal-gen3/device.js';
for (const [id, d] of [['iii', AXEFX3_DESCRIPTOR], ['fm3', FM3_DESCRIPTOR], ['fm9', FM9_DESCRIPTOR]] as const) {
  const out: string[] = [];
  for (const [slug, b] of Object.entries(d.blocks)) for (const [n, s] of Object.entries(b.params)) {
    if (s.wire_kind !== 'continuous' || s.display_min === undefined || s.enum_values) continue;
    try { s.encode(s.display_min); } catch { continue; }
    const seen = new Set<unknown>(); for (let w = 0; w <= 65534; w += 64) seen.add(s.decode(w));
    if (seen.size < 20) out.push(`${slug}.${n} ${s.display_min}..${s.display_max} ${s.unit}: ${seen.size} readings`);
  }
  console.log(`${id}: ${out.length}\n  ${out.join('\n  ')}`);
}
