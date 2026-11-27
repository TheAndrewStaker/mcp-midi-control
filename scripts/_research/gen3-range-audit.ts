/**
 * gen3-range-audit.ts (research, read-only): compare each gen-3 descriptor's
 * surfaced display range against the Axe-Fx II's device-measured range for the
 * same (block, name). The II entries come from the II's own display labels, so
 * a gen-3 range that disagrees with the II AND with its own editor-cache row is
 * a suspect. Prints the disagreements; changes nothing.
 */
import { AXEFX3_DESCRIPTOR, FM3_DESCRIPTOR, FM9_DESCRIPTOR } from '@mcp-midi-control/fractal-gen3/device.js';
import { AXEFX2_DESCRIPTOR } from '@mcp-midi-control/fractal-gen2/descriptor.js';
import { DEVICE_LABEL_CALIBRATION } from 'fractal-midi/gen2/axe-fx-ii';

const ii = AXEFX2_DESCRIPTOR;
const devs = [['axe-fx-iii', AXEFX3_DESCRIPTOR], ['fm3', FM3_DESCRIPTOR], ['fm9', FM9_DESCRIPTOR]] as const;
const show = process.argv.includes('--all');
for (const [id, d] of devs) {
  let joined = 0, agree = 0; const rows: string[] = [];
  for (const [slug, block] of Object.entries(d.blocks)) {
    for (const [name, s] of Object.entries(block.params)) {
      const key = `${slug}.${name}`;
      const cal = DEVICE_LABEL_CALIBRATION[key];
      const iis = ii.blocks[slug]?.params[name];
      if (!cal || !iis || s.display_min === undefined || s.enum_values) continue;
      joined++;
      const same = Math.abs(s.display_min - cal.displayMin) < 1e-6 && Math.abs((s.display_max ?? NaN) - cal.displayMax) < 1e-6;
      if (same) { agree++; if (!show) continue; }
      rows.push(`  ${same ? '=' : '!'} ${key.padEnd(34)} ${id} ${s.display_min}..${s.display_max} ${s.unit}  | II(device) ${cal.displayMin}..${cal.displayMax} ${cal.unit ?? ''} ${cal.scale}`);
    }
  }
  console.log(`${id}: ${joined} params join the II device-label table by name, ${agree} same range, ${joined - agree} differ`);
  console.log(rows.join('\n'));
}
