/**
 * MicroFreak preset-NAME dump over the hardware-confirmed read path. READ-ONLY.
 * Used to build a slot -> name lookup so a Program Change probe has something
 * concrete to predict against (rather than asking the user to read a number).
 * Run: npx tsx scripts/probe-microfreak-names.ts [firstSlot] [count]
 */
import { connect } from '../packages/core/src/midi/transport.js';

const first = Number(process.argv[2] ?? '1');
const count = Number(process.argv[3] ?? '8');

function buildNameRequest(seq: number, preset0: number): number[] {
  return [0xf0, 0x00, 0x20, 0x6b, 0x07, 0x01, seq & 0x7f, 0x03, 0x19,
    Math.floor(preset0 / 128), preset0 % 128, 0x00, 0xf7];
}
/** Name lives at a fixed offset 21, null-padded (hardware-confirmed 2026-07-25). */
function nameOf(reply: readonly number[]): string {
  const raw = reply.slice(21, reply.length - 1);
  const end = raw.indexOf(0x00);
  return String.fromCharCode(...(end === -1 ? raw : raw.slice(0, end)));
}

const conn = connect({ needles: ['microfreak', 'arturia'], notFoundLeadIn: 'MicroFreak not found.' });
let seq = 1;
for (let i = 0; i < count; i++) {
  const slot0 = first - 1 + i;
  const bank = Math.floor(slot0 / 128);
  const index = slot0 % 128;
  // Match on the ECHOED seq + bank + index, not just the Arturia header: a late
  // reply to a PREVIOUS request would otherwise be misattributed to this slot,
  // which is exactly how a phantom "the ceiling is 385" result gets manufactured.
  const mySeq = seq;
  const waiter = conn.receiveSysExMatching(
    (b) => b[1] === 0x00 && b[2] === 0x20 && b[3] === 0x6b
      && b[6] === mySeq && b[8] === 0x52 && b[9] === bank && b[10] === index,
    2500,
  ).catch(() => undefined);
  conn.send(buildNameRequest(seq, slot0));
  const reply = await waiter;
  console.log(`  slot ${String(slot0 + 1).padStart(3)} (bank ${bank} idx ${String(index).padStart(3)})  ${reply === undefined ? '(no reply)' : JSON.stringify(nameOf(reply))}`);
  seq = (seq + 1) & 0x7f;
}
process.exit(0);
