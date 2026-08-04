/**
 * circuit-query-exists.ts — read-only QUERY_EXISTS (0x0d) probe with CONTROLS.
 *
 * WHY. After a delete, the 0x0d oracle answered nothing at all for the target
 * slot. "No reply" is only evidence if we know what a KNOWN-FREE slot and a
 * KNOWN-OCCUPIED slot answer on the same rig in the same session. This probes
 * several slots in one run and dumps EVERY device frame each query draws (not
 * just the ones whose subcommand byte is 0x0d), so a free-slot refusal that
 * comes back under a different subcommand is visible rather than being silently
 * scored as a timeout.
 *
 * Read-only: sends only OPEN/DIR/QUERY_INFO/0x0d/CLOSE. Never 0x08, never a write.
 *
 *   npx tsx scripts/_research/circuit-query-exists.ts --pack 1 --slots 1,11,20
 */
import { connect, closeAllMidiConnections, type MidiConnection } from '../../packages/core/src/midi/transport.js';
import { endMidiScript, reconnectMidi } from '../_lib/midi-lifecycle.js';
import { readProjectDirectory } from '../../packages/circuit-tracks/src/ncs/sampleDirectory.js';
import { makeMessage, TRANSFER_CONSTANTS } from '../../packages/circuit-tracks/src/ncs/transfer.js';

const SUB = TRANSFER_CONSTANTS.SUBCMD;
const HDR = TRANSFER_CONSTANTS.HEADER;
const SUB_QUERY_EXISTS = 0x0d;
const FILE_TYPE_PROJECT = 0x03;

const argv = process.argv.slice(2);
const flag = (n: string): string | undefined => { const i = argv.indexOf(n); return i === -1 ? undefined : argv[i + 1]; };
const devicePack = Number(flag('--pack') ?? '1');
const wirePack = devicePack - 1;
const deviceSlots = (flag('--slots') ?? '11').split(',').map((s) => Number(s.trim()));

const CONNECT = { needles: ['circuit'], notFoundLeadIn: 'Circuit Tracks not found.' };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const hex = (ns: readonly number[]) => ns.map((x) => x.toString(16).padStart(2, '0')).join(' ');

async function probe(conn: MidiConnection, wireSlot: number): Promise<number[][]> {
  const inbox: number[][] = [];
  const unsub = conn.onMessage((m) => { if (m.length > 7 && HDR.every((h, i) => m[1 + i] === h)) inbox.push(m); });
  try {
    conn.send(makeMessage(SUB.CLOSE_SESSION)); await sleep(250);
    conn.send(makeMessage(SUB.OPEN_SESSION)); await sleep(300);
    conn.send(makeMessage(SUB.DIR_CONTROL, [0x01])); await sleep(100);
    conn.send(makeMessage(SUB.QUERY_INFO, [0x01, 0x00])); await sleep(100);
    conn.send(makeMessage(SUB.DIR_CONTROL, [0x02])); await sleep(100);
    conn.send(makeMessage(SUB.DIR_CONTROL, [FILE_TYPE_PROJECT, wirePack & 0x7f])); await sleep(700);
    inbox.length = 0;   // drop the directory listing; only THIS query's replies count
    conn.send(makeMessage(SUB_QUERY_EXISTS, [FILE_TYPE_PROJECT, wirePack & 0x7f, wireSlot & 0x7f]));
    await sleep(1500);
    return [...inbox];
  } finally {
    try { conn.send(makeMessage(SUB.CLOSE_SESSION)); } catch { /* port gone */ }
    unsub();
  }
}

async function main(): Promise<void> {
  let conn = connect(CONNECT);
  const dir = await readProjectDirectory(conn, wirePack);
  console.log(`Pack ${devicePack}: ${dir.occupied}/${dir.total} occupied`);
  console.log('');

  for (const deviceSlot of deviceSlots) {
    const wireSlot = deviceSlot - 1;
    const entry = dir.slots[wireSlot];
    conn = reconnectMidi(conn, CONNECT);
    const replies = await probe(conn, wireSlot);
    const dirSays = entry?.name !== undefined ? `OCCUPIED "${entry.name}"` : 'FREE (no directory entry)';
    console.log(`Project ${deviceSlot} (wire slot ${wireSlot}) — directory says ${dirSays}`);
    if (replies.length === 0) console.log('    0x0d replies: NONE');
    for (const m of replies) console.log(`    reply sub=0x${m[1 + HDR.length].toString(16).padStart(2, '0')} [${hex(m)}]`);
    console.log('');
  }
  endMidiScript();
}

main().catch((e) => { console.error(e); closeAllMidiConnections(); process.exit(1); });
