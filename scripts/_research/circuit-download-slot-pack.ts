/**
 * Download one project slot FROM A NAMED PACK (read-only).
 *
 * Why this exists: `scripts/circuit-download-slot.ts` calls
 * `downloadProject(c, slot)` with no options, and `downloadProject` defaults
 * `opts.pack` to 0 — so it silently reads Pack 1 no matter which pack the
 * device is showing. That cost a session an invalid test result on 2026-08-01
 * (asked for Pack 5 projects, got Pack 1's "Vore" and "Rain").
 *
 * Pack is 0-BASED on the wire (`fileId(slot, pack)`), so Pack 5 = 4. Slot is
 * 0-based too, so Project 41 = slot 40. Both are printed back 1-based to match
 * what the device displays.
 *
 *   npx tsx scripts/_research/circuit-download-slot-pack.ts <project 1..64> <pack 1..8> <out.ncs>
 */
import { writeFileSync } from 'node:fs';

import { connect } from '@mcp-midi-control/core/midi/transport.js';
import { downloadProject } from '@mcp-midi-control/circuit-tracks/ncs/uploadProject.js';

const project = Number(process.argv[2]);
const packDisplay = Number(process.argv[3]);
const out = process.argv[4] ?? `pack${packDisplay}_proj${project}.ncs`;

if (!Number.isInteger(project) || project < 1 || project > 64) {
  console.error('project must be 1..64 (as the device displays it)');
  process.exit(1);
}
if (!Number.isInteger(packDisplay) || packDisplay < 1 || packDisplay > 8) {
  console.error('pack must be 1..8 (as the device displays it)');
  process.exit(1);
}

const slot = project - 1;
const pack = packDisplay - 1;

async function main(): Promise<void> {
  const c = connect({ needles: ['circuit'], notFoundLeadIn: 'Circuit not found (powered on? Components closed?).' });
  try {
    const d = await downloadProject(c, slot, { pack });
    if (d.bytes) {
      writeFileSync(out, d.bytes);
      const name = Buffer.from(d.bytes.slice(0x10, 0x20)).toString('latin1').replace(/\0/g, '').trim();
      console.log(`Pack ${packDisplay} project ${project} = ${JSON.stringify(name)} -> ${out} (${d.bytes.length} bytes, crcOk=${d.crcOk})`);
    } else {
      console.log(`Pack ${packDisplay} project ${project}: empty / no readable project (${d.error ?? 'no bytes'})`);
    }
  } finally {
    c.close();
  }
}
main().catch((err) => { console.error('ERROR:', err instanceof Error ? err.message : err); process.exit(1); });
