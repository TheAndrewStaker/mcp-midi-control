/**
 * MicroFreak SysEx READ probe. READ-ONLY: sends only queries, never a write,
 * never a preset change. Nothing it sends can alter the device's memory.
 *
 * Purpose: the MicroFreak's SysEx read protocol was reverse-engineered by the
 * community from MIDI Control Center traffic (Arturia mfr id 00 20 6B, device
 * code 07). We have the decoded shapes but have never put them on a wire
 * ourselves. This probe tests, in order:
 *
 *   1. Universal Identity Request (F0 7E 7F 06 01 F7). Standard MIDI, answers
 *      with the device's own family/model/version bytes. Confirms the device
 *      talks SysEx at all before we trust anything Arturia-specific.
 *   2. Preset NAME request: F0 00 20 6B 07 01 <seq> 03 19 <bank> <preset> 00 F7
 *      Expected answer carries command 0x52 followed by the name in ASCII.
 *   3. The same for a couple of other slots, to prove the bank/index addressing
 *      (bank = preset div 128, index = preset mod 128) rather than assuming it.
 *
 * A clean pass here validates the whole decoded read path in one session and is
 * the gate on building real MicroFreak support. A failure is equally useful: it
 * tells us the community decode does not survive firmware 5.
 *
 * Run: npx tsx scripts/probe-microfreak-sysex-read.ts
 */
import { connect } from '../packages/core/src/midi/transport.js';

const ARTURIA = [0x00, 0x20, 0x6b];
const MICROFREAK = 0x07;

const hex = (b: readonly number[]): string => b.map((x) => x.toString(16).padStart(2, '0')).join(' ');

/** Printable-ASCII rendering, with non-printables as '.', for spotting names in a dump. */
const ascii = (b: readonly number[]): string =>
  b.map((x) => (x >= 0x20 && x <= 0x7e ? String.fromCharCode(x) : '.')).join('');

/** Preset name request. `seq` is echoed back by the device so answers can be ordered. */
function buildNameRequest(seq: number, preset0: number): number[] {
  const bank = Math.floor(preset0 / 128);
  const index = preset0 % 128;
  return [0xf0, ...ARTURIA, MICROFREAK, 0x01, seq & 0x7f, 0x03, 0x19, bank, index, 0x00, 0xf7];
}

async function main(): Promise<void> {
  const conn = connect({
    needles: ['microfreak', 'arturia'],
    notFoundLeadIn: 'MicroFreak not found in the MIDI device list.',
    notFoundHints: [
      'The MicroFreak is USB MIDI class compliant and needs no driver on Windows.',
      'Check the USB-B cable is a data cable and the unit is powered on.',
    ],
  });
  console.log('Connected to the MicroFreak.\n');

  // --- 1. Universal Identity Request ---------------------------------------
  console.log('[1] Universal Identity Request (F0 7E 7F 06 01 F7)');
  {
    const waiter = conn.receiveSysEx(2000).catch(() => undefined);
    conn.send([0xf0, 0x7e, 0x7f, 0x06, 0x01, 0xf7]);
    const reply = await waiter;
    if (reply === undefined) {
      console.log('    NO REPLY within 2s.');
      console.log('    Not fatal on its own: some devices ignore Identity Request. Continuing.\n');
    } else {
      console.log(`    <- ${hex(reply)}`);
      const isArturia = reply[5] === 0x00 && reply[6] === 0x20 && reply[7] === 0x6b;
      console.log(`    Arturia manufacturer id at bytes 5-7: ${isArturia ? 'YES' : 'no'}`);
      console.log();
    }
  }

  // --- 2 + 3. Preset name reads --------------------------------------------
  // Slot 0 and 1 are the basic case; 128 crosses the bank boundary, which is the
  // part of the addressing scheme most likely to be wrong if it is wrong at all.
  const slots = [0, 1, 127, 128];
  let seq = 0x01;
  let answered = 0;

  for (const preset0 of slots) {
    const req = buildNameRequest(seq, preset0);
    const bank = Math.floor(preset0 / 128);
    const index = preset0 % 128;
    console.log(`[2] Preset name, slot ${preset0 + 1} (bank ${bank}, index ${index}), seq 0x${seq.toString(16)}`);
    console.log(`    -> ${hex(req)}`);

    // Register the listener BEFORE the write so the answer cannot race ahead.
    const waiter = conn
      .receiveSysExMatching((b) => b[1] === 0x00 && b[2] === 0x20 && b[3] === 0x6b, 2500)
      .catch(() => undefined);
    conn.send(req);
    if (conn.lastSendError !== undefined) {
      console.log(`    SEND FAILED: ${conn.lastSendError.message}`);
      break;
    }
    const reply = await waiter;

    if (reply === undefined) {
      console.log('    NO REPLY within 2.5s.\n');
    } else {
      answered++;
      console.log(`    <- ${hex(reply)}`);
      const echoedSeq = reply[6];
      const cmd = reply[8];
      console.log(`    seq echoed: 0x${echoedSeq?.toString(16)} (sent 0x${seq.toString(16)})${echoedSeq === seq ? ' MATCH' : ' MISMATCH'}`);
      console.log(`    command byte: 0x${cmd?.toString(16)} (expected 0x52 for a name answer)`);
      console.log(`    ascii: "${ascii(reply)}"\n`);
    }
    seq = (seq + 1) & 0x7f;
  }

  console.log('---');
  console.log(`Name requests answered: ${answered}/${slots.length}`);
  console.log(answered === 0
    ? 'The decoded read path did NOT respond. Either the shape is wrong for this firmware, or the device needs something first.'
    : 'The decoded read path IS live on this firmware. That validates the community decode on real hardware.');
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
