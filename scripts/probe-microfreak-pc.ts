/**
 * MicroFreak PROGRAM CHANGE probe.
 *
 * Answers three things the v5 manual never documents (it contains no mention of
 * Program Change at all) in one pass:
 *
 *   1. Does the MicroFreak respond to Program Change?
 *   2. Is it 0-based or 1-based? Sending PC 4 loads "MotivSeq" (slot 5) if
 *      0-based, "Ether" (slot 4) if 1-based. The two names are unambiguous.
 *   3. Is bank 3 / index 0 the EDIT BUFFER? That address answers when nothing
 *      else in bank 3 does. If it tracks the currently-loaded preset, it is the
 *      working buffer and gives us a self-validating "what is loaded right now"
 *      read, which is worth a great deal (every future probe stops needing a
 *      human to read the screen).
 *
 * Writes: exactly one Program Change. It loads a stored preset over the working
 * buffer, so unsaved knob edits on the current preset are discarded. Nothing is
 * written to the device's memory.
 *
 * Run: npx tsx scripts/probe-microfreak-pc.ts <channel> <program>
 */
import { connect } from '../packages/core/src/midi/transport.js';

const channel = Number(process.argv[2] ?? '3');
const program = Number(process.argv[3] ?? '4');

const EDIT_BUFFER = { bank: 3, index: 0 };

function nameRequest(seq: number, bank: number, index: number): number[] {
  return [0xf0, 0x00, 0x20, 0x6b, 0x07, 0x01, seq & 0x7f, 0x03, 0x19, bank, index, 0x00, 0xf7];
}
function nameOf(reply: readonly number[]): string {
  const raw = reply.slice(21, reply.length - 1);
  const end = raw.indexOf(0x00);
  return String.fromCharCode(...(end === -1 ? raw : raw.slice(0, end)));
}

const conn = connect({ needles: ['microfreak', 'arturia'], notFoundLeadIn: 'MicroFreak not found.' });
let seq = 1;

async function readName(bank: number, index: number): Promise<string | undefined> {
  const mySeq = seq;
  seq = (seq + 1) & 0x7f;
  const waiter = conn.receiveSysExMatching(
    (b) => b[1] === 0x00 && b[2] === 0x20 && b[3] === 0x6b
      && b[6] === mySeq && b[8] === 0x52 && b[9] === bank && b[10] === index,
    2500,
  ).catch(() => undefined);
  conn.send(nameRequest(mySeq, bank, index));
  const reply = await waiter;
  return reply === undefined ? undefined : nameOf(reply);
}

const before = await readName(EDIT_BUFFER.bank, EDIT_BUFFER.index);
console.log(`edit-buffer candidate (bank 3 idx 0) BEFORE : ${before === undefined ? '(no reply)' : JSON.stringify(before)}`);
console.log(`  (user reports the device is showing Preset 3, whose stored name is "Trance")`);

console.log(`\n-> Program Change: channel ${channel}, program ${program}  [${(0xc0 | (channel - 1)).toString(16)} ${program.toString(16)}]`);
conn.send([0xc0 | (channel - 1), program]);
if (conn.lastSendError !== undefined) console.log(`   SEND FAILED: ${conn.lastSendError.message}`);
await new Promise((r) => setTimeout(r, 400));

const after = await readName(EDIT_BUFFER.bank, EDIT_BUFFER.index);
console.log(`\nedit-buffer candidate (bank 3 idx 0) AFTER  : ${after === undefined ? '(no reply)' : JSON.stringify(after)}`);

console.log('\n--- interpretation ---');
if (before !== undefined && after !== undefined && before !== after) {
  console.log(`bank 3 idx 0 CHANGED (${JSON.stringify(before)} -> ${JSON.stringify(after)}): it tracks the loaded preset.`);
  console.log('That makes it the edit buffer / current-preset address, and the PC landed.');
} else if (before !== undefined && after !== undefined) {
  console.log(`bank 3 idx 0 did not change (${JSON.stringify(before)}). Either it is NOT the edit buffer,`);
  console.log('or the Program Change did not land. The device display is the tiebreaker.');
}
console.log(`\nExpected if the PC landed: 0-based -> slot ${program + 1} "MotivSeq"; 1-based -> slot ${program} "Ether".`);
process.exit(0);
