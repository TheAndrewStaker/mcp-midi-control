/**
 * MicroFreak-side READ-ONLY sanity check for the M>PCR bring-up.
 *
 * Sends ONLY the global READ opcode 0x43 — never 0x42 — so it cannot alter a
 * setting. Answers the question `midi_thru = On` alone does not: do notes
 * actually LEAVE the 5-pin MIDI Out on the channel the VE-500's M>PCR is
 * listening to?
 *
 * Run: npx tsx scripts/bringup-m2pcr-mfcheck.ts
 */
import { connect } from '../packages/core/src/midi/transport.js';
import {
  buildGlobalRead,
  globalReplyMatcher,
  decodeGlobalReply,
} from '../packages/arturia/src/codec/sysex.js';

const CHECKS: Array<{ id: number; label: string; decode: (v: number) => string }> = [
  { id: 0x20, label: 'MIDI Input Chan', decode: (v) => `Ch.${v + 1} (stored 0-based)` },
  { id: 0x21, label: 'MIDI Output Chan', decode: (v) => `Ch.${v + 1} (stored 0-based)` },
  {
    id: 0x25,
    label: 'Output dest',
    // BITMASK: bit0 = USB, bit2 = MIDI. USB=1 and BOTH=5 are the observed values.
    decode: (v) => `${v} -> USB:${v & 1 ? 'yes' : 'NO'} MIDI-DIN:${v & 4 ? 'yes' : 'NO'}`,
  },
  { id: 0x2b, label: 'Arp/Seq MIDI out', decode: (v) => (v ? 'On' : 'Off') },
  { id: 0x2e, label: 'Sync Source', decode: (v) => ['Int', 'USB', 'MIDI', 'Clock', 'Auto'][v] ?? String(v) },
  { id: 0x3b, label: 'MIDI Thru', decode: (v) => (v ? 'On' : 'Off') },
];

const conn = connect({ needles: ['microfreak', 'arturia'], notFoundLeadIn: 'MicroFreak not found.' });
let seq = 0;

for (const c of CHECKS) {
  const s = seq; seq = (seq + 1) & 0x7f;
  const waiter = conn.receiveSysExMatching(globalReplyMatcher(c.id), 600).catch(() => undefined);
  conn.send(buildGlobalRead(s, c.id)); // 0x43 READ. Never 0x42.
  const reply = await waiter;
  const v = reply === undefined ? undefined : decodeGlobalReply(reply);
  console.log(
    `  0x${c.id.toString(16).padStart(2, '0')}  ${c.label.padEnd(18)} = ${v === undefined ? 'NO REPLY' : `${v}  ${c.decode(v)}`}`,
  );
}

conn.close();
process.exit(0);
