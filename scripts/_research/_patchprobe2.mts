/**
 * READ-ONLY. Hypothesis: the runner's pre-write occupancy check (probeSlots, which uses one-shot
 * `receiveSysExMatching` waiters) leaves a pending receiver that SWALLOWS the first SysEx the
 * frame replay's inbox is waiting for. Reproduce the runner's exact order, with no write frames.
 */
import { connect } from '../../packages/core/src/midi/transport.js';
import { endMidiScript } from '../_lib/midi-lifecycle.js';
import { makeMessage, TRANSFER_CONSTANTS } from '../../packages/circuit-tracks/src/ncs/transfer.js';
import { probeSlots, FILE_TYPE } from '../../packages/circuit-tracks/src/ncs/fileDelete.js';
const SUB = TRANSFER_CONSTANTS.SUBCMD as Record<string, number>;
const PACK = 3;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const hx = (m: number[]) => m.map((x) => x.toString(16).padStart(2, '0')).join(' ');
const conn = connect({ needles: ['circuit'], notFoundLeadIn: 'Circuit not found.' });

for (const settle of [600, 2500]) {
  console.log(`\n=== runner order, settle ${settle} ms after the occupancy check`);
  const probe = await probeSlots(conn, FILE_TYPE.PATCH, Array.from({ length: 16 }, (_, g) => g), { pack: PACK });
  console.log(`  occupancy check done (${probe.slots.filter((s) => s.exists).length} occupied)`);
  await sleep(settle);

  const seen: number[][] = [];
  const unsub = conn.onMessage((m) => seen.push(m));
  for (const msg of [
    makeMessage(SUB.CLOSE_SESSION), makeMessage(SUB.OPEN_SESSION),
    makeMessage(SUB.DIR_CONTROL, [0x01]), makeMessage(SUB.QUERY_INFO, [0x01, 0x00]),
    makeMessage(SUB.QUERY_INFO, [0x01, 0x01]), makeMessage(SUB.DIR_CONTROL, [0x02]),
    makeMessage(SUB.DIR_CONTROL, [0x04, PACK]),
  ]) { conn.send(msg); await sleep(250); }
  seen.length = 0;
  conn.send(makeMessage(SUB.QUERY_EXISTS, [0x04, PACK, 0]));
  await sleep(1500);
  console.log(`  QUERY_EXISTS g0 -> ${seen.length} reply(ies)${seen.length ? `\n     ${hx(seen[0])}` : '   <-- REPRODUCED THE FAILURE'}`);
  unsub();
  conn.send(makeMessage(SUB.CLOSE_SESSION)); await sleep(300);
}
endMidiScript(0);
