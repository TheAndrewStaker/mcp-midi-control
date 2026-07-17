/**
 * Bench diagnostic: discriminate WHY the sample-directory listing read 0/64
 * on a pack Components shows as populated (2026-07-10, founder screenshot).
 *
 * Two competing hypotheses:
 *   H1: the fileType=0x05 LISTING analogy is wrong (device does not answer
 *       DIR_ENTRY for samples).
 *   H2: pack targeting is wrong (call hardcodes pack 0x00; the founder now
 *       has an SD card with multiple packs, only "Pack 1" written).
 *
 * Discriminator: in ONE read-only session, issue DIR_CONTROL listings for
 *   (0x03 project, pack 0)  <- capture-confirmed fileType, known-populated
 *   (0x05 sample,  pack 0)  <- the failing call
 *   (0x03 project, pack 1) and (0x05 sample, pack 1)
 * and print the RAW header replies (distinguishing "count=0 reply" from
 * "no reply at all") plus up to 3 entry names per listing.
 *
 * Read-only by construction: OPEN_SESSION / DIR_CONTROL / QUERY_INFO /
 * CLOSE_SESSION only, the same frame classes as the shipped read path.
 * Never sends WRITE_INIT/DATA/FINISH/SET_FILENAME.
 */
import { connect, type MidiConnection } from '@mcp-midi-control/core/midi/transport.js';
import { makeMessage, TRANSFER_CONSTANTS } from '@mcp-midi-control/circuit-tracks/ncs/transfer.js';
import { parseDirListHeader, parseDirEntry } from '@mcp-midi-control/circuit-tracks/ncs/sampleDirectory.js';

const SUB = TRANSFER_CONSTANTS.SUBCMD;
const hex = (a: readonly number[]) => a.map((b) => b.toString(16).padStart(2, '0')).join(' ');

async function listDir(conn: MidiConnection, fileType: number, pack: number): Promise<void> {
  const label = `fileType=0x${fileType.toString(16).padStart(2, '0')} pack=${pack}`;
  const headerP = conn.receiveSysExMatching((m) => m[7] === SUB.DIR_CONTROL, 600).catch(() => [] as number[]);
  conn.send(makeMessage(SUB.DIR_CONTROL, [fileType, pack]));
  const header = await headerP;
  if (header.length === 0) {
    console.log(`${label}: NO header reply (silence)`);
    return;
  }
  const parsed = parseDirListHeader(header);
  console.log(`${label}: header raw=[${hex(header)}] -> count=${parsed?.count ?? '?'} (echo fileType=0x${(parsed?.fileType ?? 0).toString(16)}, pack=${parsed?.pack ?? '?'})`);
  const n = Math.min(parsed?.count ?? 0, 3);
  for (let i = 0; i < (parsed?.count ?? 0); i++) {
    const entry = await conn.receiveSysExMatching((m) => m[7] === 0x0c, 600).catch(() => [] as number[]);
    if (entry.length === 0) { console.log('  (entry stream stalled)'); break; }
    const e = parseDirEntry(entry);
    if (i < n) console.log(`  entry: slot=${e?.slot} name="${e?.name}" (pack echo=${e?.pack})`);
  }
  if ((parsed?.count ?? 0) > 3) console.log(`  ... ${(parsed?.count ?? 0) - 3} more entries drained`);
}

async function main(): Promise<void> {
  const conn = connect({ needles: ['circuit'] });
  try {
    // Capture-identical read-only prelude.
    for (const msg of [
      makeMessage(SUB.OPEN_SESSION),
      makeMessage(SUB.DIR_CONTROL, [0x01]),
      makeMessage(SUB.QUERY_INFO, [0x01, 0x00]),
      makeMessage(SUB.DIR_CONTROL, [0x02]),
    ]) {
      const p = conn.receiveSysEx(600).catch(() => [] as number[]);
      conn.send(msg);
      await p;
    }
    await listDir(conn, 0x03, 0); // control: capture-confirmed type, pack 0
    await listDir(conn, 0x05, 0); // the failing call
    await listDir(conn, 0x03, 1); // pack-1 variants (SD multi-pack world)
    await listDir(conn, 0x05, 1);
  } finally {
    try { conn.send(makeMessage(SUB.CLOSE_SESSION)); } catch { /* dead handle */ }
    conn.close();
  }
}

main().catch((err) => { console.error(`diag failed: ${err instanceof Error ? err.message : String(err)}`); process.exit(1); });
