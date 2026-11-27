/**
 * gen3-display-roundtrip.ts (research, read-only): for every writable
 * continuous gen-3 param, does a value the read path returns survive a write
 * and re-read? decode(encode(decode(w))) === decode(w) over a dense wire sweep.
 * Params whose encode refuses by design (meters, spares) are skipped.
 */
import { AXEFX3_DESCRIPTOR, FM3_DESCRIPTOR, FM9_DESCRIPTOR } from '@mcp-midi-control/fractal-gen3/device.js';
for (const [id, d] of [['axe-fx-iii', AXEFX3_DESCRIPTOR], ['fm3', FM3_DESCRIPTOR], ['fm9', FM9_DESCRIPTOR]] as const) {
  let params = 0, checks = 0, bad = 0, refused = 0; const badParams = new Set<string>(); const ex: string[] = [];
  for (const [slug, b] of Object.entries(d.blocks)) for (const [n, s] of Object.entries(b.params)) {
    if (s.wire_kind !== 'continuous' || s.display_min === undefined || s.enum_values) continue;
    params++;
    for (let w = 0; w <= 65534; w += 61) {
      let v: unknown; try { v = s.decode(w); } catch { continue; }
      if (typeof v !== 'number') continue;
      let wire: number; try { wire = Number(s.encode(v)); } catch { refused++; continue; }
      checks++;
      const back = s.decode(wire);
      if (back !== v) { bad++; badParams.add(`${slug}.${n}`); if (ex.length < 6) ex.push(`${slug}.${n} w${w}: ${v} -> ${back}`); }
    }
  }
  console.log(`${id}: ${params} params, ${checks} reads written back, ${bad} change (${badParams.size} params), ${refused} refused${ex.length ? '\n   ' + ex.join('\n   ') : ''}`);
}
