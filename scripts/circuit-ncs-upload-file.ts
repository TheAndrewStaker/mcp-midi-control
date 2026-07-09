/**
 * Upload a prepared .ncs project file to a device slot over SysEx, then read it
 * back and verify byte-exact. Uses the shipped (hardware-confirmed) transfer.
 *
 * Requires the "Circuit Tracks" port to be FREE (disconnect Components first).
 *
 * Run:  npx tsx scripts/circuit-ncs-upload-file.ts [path.ncs] [slot]
 */

import { readFileSync } from 'node:fs';

import { connect } from '@mcp-midi-control/core/midi/transport.js';
import { downloadProject, uploadProject } from '@mcp-midi-control/circuit-tracks/ncs/uploadProject.js';
import { decodeDrumPattern, drumPatternToString } from '@mcp-midi-control/circuit-tracks/ncs/drumPattern.js';

const FILE = process.argv[2] ?? 'C:/Users/Steph/Downloads/Drum1_Kick.ncs';
const SLOT = Number(process.argv[3] ?? 17);

async function main(): Promise<void> {
  const buf = new Uint8Array(readFileSync(FILE));
  console.log(`Uploading "${FILE}" (${buf.length} bytes) to slot ${SLOT}.`);
  for (let t = 0; t < 4; t++) console.log(`  Drum${t + 1} p0: ${drumPatternToString(decodeDrumPattern(buf, t, 0))}`);

  const conn = connect({ needles: ['circuit'], notFoundLeadIn: 'Circuit Tracks not found (is Components still holding the port?).' });
  try {
    const res = await uploadProject(conn, buf, SLOT);
    if (!res.ok) { console.error(`FAIL: ${res.error}`); process.exit(2); }
    console.log(`Upload ok (${res.blocks} blocks acked). Reading slot ${SLOT} back...`);
    const dl = await downloadProject(conn, SLOT);
    let mismatch = -1;
    if (dl.bytes) for (let i = 0; i < buf.length; i++) if (dl.bytes[i] !== buf[i]) { mismatch = i; break; }
    console.log(`  readback CRC ok: ${dl.crcOk}; byte-exact vs uploaded: ${mismatch === -1 ? 'IDENTICAL' : `differ @0x${mismatch.toString(16)}`}`);
    console.log(mismatch === -1 && dl.crcOk
      ? `\nPASS: "Drum1 Kick" written to slot ${SLOT}, verified by readback.`
      : '\nINCOMPLETE: see diffs above.');

    // Refresh WITHOUT power-cycle: a Program Change loads the slot from flash
    // (research hypothesis). Bounce to a different slot then back so the device
    // can't treat it as "already loaded" and no-op.
    const BOUNCE = SLOT === 16 ? 0 : 16;
    const pgm = (slot: number) => conn.send([0xc0 | 15, slot & 0x7f]); // ch16 Program Change, instant
    console.log(`\nLoading slot ${SLOT} via PGM bounce (ch16: ${BOUNCE} → ${SLOT}) to avoid a power-cycle...`);
    pgm(BOUNCE); await new Promise((r) => setTimeout(r, 500)); pgm(SLOT); await new Promise((r) => setTimeout(r, 300));
    console.log(`Sent. CHECK THE DEVICE NOW (no power-cycle): is project ${SLOT} active and playing ONLY a four-on-the-floor kick on Drum 1?`);
  } finally {
    conn.close();
  }
}

main().catch((err) => { console.error('ERROR:', err instanceof Error ? err.message : err); process.exit(1); });
