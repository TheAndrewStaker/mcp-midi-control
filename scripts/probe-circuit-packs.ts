/**
 * probe-circuit-packs — read the Circuit Tracks microSD PACK DIRECTORY by name.
 *
 * The confirming key-press for the 2026-07-16 pack-addressing decode
 * (packDirectory.ts): the frames + parse are capture-exact, but this server's
 * own send/parse loop has not been round-tripped on a device.
 *
 * READ-ONLY: sends only OPEN_SESSION / DIR_CONTROL / QUERY_INFO / CLOSE_SESSION.
 * Never WRITE_INIT / WRITE_DATA / WRITE_FINISH / SET_FILENAME, so it cannot open
 * (or abandon) a write transaction. Safe to run against a loaded device.
 *
 * Requires the "Circuit Tracks" port FREE (close Novation Components).
 *
 *   npx tsx scripts/probe-circuit-packs.ts
 */
import { connect } from '@mcp-midi-control/core/midi/transport.js';
import { readPackDirectory } from '@mcp-midi-control/circuit-tracks/ncs/packDirectory.js';

async function main(): Promise<void> {
  const conn = connect({
    needles: ['circuit'],
    notFoundLeadIn: 'Circuit Tracks not found (powered on? Novation Components closed?).',
  });
  try {
    if (!conn.hasInput) {
      console.error('Circuit Tracks input port unavailable; the pack directory needs a bidirectional connection.');
      process.exit(1);
    }
    console.log('Reading pack directory (read-only)...\n');
    const result = await readPackDirectory(conn);

    console.log(`Device reports ${result.count} pack(s); ${result.packs.length} name(s) received.\n`);
    if (result.packs.length === 0) {
      console.log('No pack entries came back. Either the card holds no packs, or the read timed out.');
    }
    for (const p of result.packs) {
      console.log(`  Pack ${p.device_pack}  (wire index ${p.index})   "${p.name}"`);
    }
    if (result.note) console.log(`\nNote: ${result.note}`);

    console.log('\nWire index is the byte the fileId carries (0-based); "Pack N" is what the front panel shows.');
  } finally {
    conn.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
