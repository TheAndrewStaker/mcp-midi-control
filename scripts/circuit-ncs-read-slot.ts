/**
 * Read a project slot off the device and inspect it (non-destructive). Used to
 * pull a genuine BLANK project from an empty slot as an authoring template.
 *
 * Run:  npx tsx scripts/circuit-ncs-read-slot.ts [slot] [savePath]
 */

import { writeFileSync } from 'node:fs';
import { connect } from '@mcp-midi-control/core/midi/transport.js';
import { downloadProject } from '@mcp-midi-control/circuit-tracks/ncs/uploadProject.js';
import { decodeDrumPattern, drumPatternToString } from '@mcp-midi-control/circuit-tracks/ncs/drumPattern.js';

const SLOT = Number(process.argv[2] ?? 20);
const SAVE = process.argv[3] ?? `C:/Users/Steph/Downloads/blank_slot${SLOT}.ncs`;

async function main(): Promise<void> {
  const conn = connect({ needles: ['circuit'], notFoundLeadIn: 'Circuit Tracks not found (is Components holding the port?).' });
  try {
    console.log(`Reading slot ${SLOT}...`);
    const dl = await downloadProject(conn, SLOT);
    if (!dl.ok || !dl.bytes) { console.error(`FAIL: ${dl.error ?? 'no bytes'}`); process.exit(2); }
    const b = dl.bytes;
    const name = String.fromCharCode(...b.slice(0x10, 0x20)).replace(/[^\x20-\x7e]/g, '?').trimEnd();
    console.log(`  ${b.length} bytes, CRC ok: ${dl.crcOk}, name @0x10: "${name}"`);
    let totalHits = 0;
    for (let t = 0; t < 4; t++) {
      const grids = Array.from({ length: 8 }, (_v, p) => drumPatternToString(decodeDrumPattern(b, t, p)));
      const hits = grids.join('').split('x').length - 1;
      totalHits += hits;
      console.log(`  Drum${t + 1}: ${hits} hits across 8 patterns (p0: ${grids[0]})`);
    }
    console.log(`  total drum hits (all tracks, all patterns): ${totalHits}  → ${totalHits === 0 ? 'EMPTY (usable blank template)' : 'has content'}`);
    writeFileSync(SAVE, b);
    console.log(`  saved to ${SAVE}`);
  } finally {
    conn.close();
  }
}

main().catch((err) => { console.error('ERROR:', err instanceof Error ? err.message : err); process.exit(1); });
