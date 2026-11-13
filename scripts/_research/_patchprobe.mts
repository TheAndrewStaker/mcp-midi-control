/**
 * READ-ONLY. Why does QUERY_EXISTS answer inside probeSlots' session but not inside the frame
 * replay's prelude? Sends ONLY session/dir/query frames - no WRITE_INIT, no WRITE_DATA, no DELETE.
 *
 * Two preludes, same query, same pack. A: the frame plan's (extra QUERY_INFO [01 01], dir_scope
 * fire-and-forget). B: openScopedSession's (no extra query_info, and it WAITS for the dir header).
 */
import { connect } from '../../packages/core/src/midi/transport.js';
import { endMidiScript } from '../_lib/midi-lifecycle.js';
import { makeMessage, TRANSFER_CONSTANTS } from '../../packages/circuit-tracks/src/ncs/transfer.js';
const SUB = TRANSFER_CONSTANTS.SUBCMD as Record<string, number>;
const PACK = 3;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const hx = (m: number[]) => m.map((x) => x.toString(16).padStart(2, '0')).join(' ');

const conn = connect({ needles: ['circuit'], notFoundLeadIn: 'Circuit not found.' });
const seen: number[][] = [];
conn.onMessage((m) => seen.push(m));
const drain = () => { const n = seen.splice(0); return n; };

async function run(label: string, prelude: number[][], waitHeader: boolean) {
  console.log(`\n=== ${label}`);
  conn.send(makeMessage(SUB.CLOSE_SESSION)); await sleep(250); drain();
  for (const msg of prelude) { conn.send(msg); await sleep(200); }
  if (waitHeader) {
    conn.send(makeMessage(SUB.DIR_CONTROL, [0x04, PACK]));
    await sleep(500);
    console.log(`  dir header/listing replies: ${drain().length}`);
  } else {
    conn.send(makeMessage(SUB.DIR_CONTROL, [0x04, PACK]));
    await sleep(500); drain();
  }
  drain();
  conn.send(makeMessage(SUB.QUERY_EXISTS, [0x04, PACK, 0]));
  await sleep(1500);
  const replies = drain();
  console.log(`  QUERY_EXISTS g0 -> ${replies.length} reply(ies)`);
  for (const r of replies.slice(0, 3)) console.log(`     ${hx(r)}`);
  conn.send(makeMessage(SUB.CLOSE_SESSION)); await sleep(250); drain();
}

// A = the frame plan's prelude (what failed twice)
await run('A: frame-plan prelude (extra QUERY_INFO 01 01, dir_scope not awaited)', [
  makeMessage(SUB.OPEN_SESSION),
  makeMessage(SUB.DIR_CONTROL, [0x01]),
  makeMessage(SUB.QUERY_INFO, [0x01, 0x00]),
  makeMessage(SUB.QUERY_INFO, [0x01, 0x01]),
  makeMessage(SUB.DIR_CONTROL, [0x02]),
], false);

// B = openScopedSession's prelude (what probeSlots uses, and it works)
await run('B: openScopedSession prelude (no extra query_info, dir header awaited)', [
  makeMessage(SUB.OPEN_SESSION),
  makeMessage(SUB.DIR_CONTROL, [0x01]),
  makeMessage(SUB.QUERY_INFO, [0x01, 0x00]),
  makeMessage(SUB.DIR_CONTROL, [0x02]),
], true);

endMidiScript(0);
