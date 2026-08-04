/**
 * MicroFreak FULL PRESET DUMP probe. READ-ONLY.
 *
 * The name read is already hardware-confirmed. This tests the next layer: the
 * multi-packet preset dump, which is what a real librarian / get_preset would be
 * built on. Community-decoded shape:
 *
 *   start dump :  F0 00 20 6B 07 01 <seq> 03 19 <bank> <index> 01 F7
 *   ack        :  F0 00 20 6B 07 01 <seq> 00 15 F7
 *   data req   :  F0 00 20 6B 07 01 <seq> 01 18 00 F7      (repeat)
 *   data packet:  F0 00 20 6B 07 01 <seq> <len> 16 ...     0x16 = more follow
 *                                              17          0x17 = LAST packet
 *
 * Self-validating: a coherent run ends on a 0x17 packet. If the stream never
 * terminates, or the ack never comes, the decode does not hold on this firmware
 * and we learn that without needing anyone to listen to anything.
 *
 * Run: npx tsx scripts/probe-microfreak-dump.ts [slot] [maxPackets]
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { connect } from '../packages/core/src/midi/transport.js';

const slot = Number(process.argv[2] ?? '1');
const maxPackets = Number(process.argv[3] ?? '80');
const slot0 = slot - 1;
const bank = Math.floor(slot0 / 128);
const index = slot0 % 128;

const isArturia = (b: readonly number[]): boolean => b[1] === 0x00 && b[2] === 0x20 && b[3] === 0x6b;
const hex = (b: readonly number[]): string => b.map((x) => x.toString(16).padStart(2, '0')).join(' ');
const ascii = (b: readonly number[]): string =>
  b.map((x) => (x >= 0x20 && x <= 0x7e ? String.fromCharCode(x) : '.')).join('');

const conn = connect({ needles: ['microfreak', 'arturia'], notFoundLeadIn: 'MicroFreak not found.' });
let seq = 0x10;
const next = (): number => { const s = seq; seq = (seq + 1) & 0x7f; return s; };

async function ask(msg: number[], timeout = 2500): Promise<number[] | undefined> {
  const waiter = conn.receiveSysExMatching(isArturia, timeout).catch(() => undefined);
  conn.send(msg);
  return waiter;
}

console.log(`Preset dump: slot ${slot} (bank ${bank}, index ${index})\n`);

const startSeq = next();
const ack = await ask([0xf0, 0x00, 0x20, 0x6b, 0x07, 0x01, startSeq, 0x03, 0x19, bank, index, 0x01, 0xf7]);
console.log(`[start dump] -> seq 0x${startSeq.toString(16)}`);
if (ack === undefined) {
  console.log('  NO ACK. The dump-start shape does not hold on this firmware.');
  process.exit(1);
}
console.log(`  <- ${hex(ack)}`);
console.log(`  command byte 0x${ack[8]?.toString(16)} (expected 0x15 = ack)\n`);

const packets: number[][] = [];
let sawLast = false;
for (let i = 0; i < maxPackets; i++) {
  const s = next();
  const pkt = await ask([0xf0, 0x00, 0x20, 0x6b, 0x07, 0x01, s, 0x01, 0x18, 0x00, 0xf7]);
  if (pkt === undefined) { console.log(`[packet ${i}] NO REPLY, stopping.`); break; }
  const cmd = pkt[8];
  packets.push(pkt);
  if (i < 3 || cmd === 0x17) {
    console.log(`[packet ${String(i).padStart(2)}] cmd 0x${cmd?.toString(16)} len 0x${pkt[7]?.toString(16)}  ${hex(pkt.slice(9, 25))}...`);
    console.log(`            ascii: "${ascii(pkt.slice(9, 41))}"`);
  }
  if (cmd === 0x17) { sawLast = true; console.log(`\n  LAST packet (0x17) at index ${i}.`); break; }
  if (cmd !== 0x16) { console.log(`  unexpected command 0x${cmd?.toString(16)}, stopping.`); break; }
}

console.log('\n--- result ---');
console.log(`packets received : ${packets.length}`);
console.log(`terminated cleanly: ${sawLast ? 'YES (saw the 0x17 last-packet marker)' : 'NO'}`);
const payload = packets.flatMap((p) => p.slice(9, p.length - 1));
console.log(`assembled payload : ${payload.length} bytes`);

if (packets.length > 0) {
  mkdirSync('samples/arturia-microfreak/dumps', { recursive: true });
  const path = `samples/arturia-microfreak/dumps/preset-${String(slot).padStart(3, '0')}.bin`;
  writeFileSync(path, Buffer.from(payload));
  console.log(`payload saved     : ${path}`);
  const printable = ascii(payload).replace(/\.{3,}/g, ' ');
  console.log(`\nstrings in payload:\n  ${printable.slice(0, 400)}`);
}
console.log(sawLast
  ? '\n=> The multi-packet dump path WORKS on this firmware. This is the foundation a real get_preset needs.'
  : '\n=> Dump did not terminate cleanly. Do not build on this shape yet.');
process.exit(0);
