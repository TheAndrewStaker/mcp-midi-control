/**
 * HW-VE500-014 — does the MicroFreak's MIDI relay hole FOLLOW its Input Chan?
 *
 * The 2026-07-28 measurement saw Ch.3 absent at the VE-500's DIN In while the MicroFreak's Input
 * Chan was 3. ONE window, ONE Input Chan value, ONE hole: the independent variable was never varied.
 * Every later decision - moving the MicroFreak to Ch.2 and the VE-500 to Ch.3 - rests on the
 * inference that the hole moved with the setting. This measures it.
 *
 * METHOD. Send into the MicroFreak; read what survives at the far end. The VE-500 can echo whatever
 * arrives at its DIN In back out over USB (`system_midi.midi_usb_out_thru`), which is the only
 * instrument in the rig that can see the far end of this cable. No human observation is needed.
 *
 *   ch4  POSITIVE CONTROL, and it is not optional: neither device's receive channel, so it MUST
 *        arrive. Without it a dead cable, a wrong port or a disabled thru reads as "hole everywhere"
 *        and every other result is meaningless.
 *   ch3  the VE-500's channel - the one the whole vocal plan needs to survive the relay
 *   ch2  the MicroFreak's OWN receive channel - expected to be eaten if the hole follows the setting
 *
 * Read-only with respect to stored state: the one setting it changes (`midi_usb_out_thru`) is read
 * first and restored at the end, whatever happens.
 */
import { connect } from '../../packages/core/src/midi/transport.js';
import { endMidiScript } from '../_lib/midi-lifecycle.js';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const mf = connect({ needles: ['microfreak'], notFoundLeadIn: 'MicroFreak not found on USB.' });
const ve = connect({ needles: ['ve-500'], notFoundLeadIn: 'VE-500 not found on USB.' });

/** Roland DT1 for system_midi.midi_usb_out_thru (addr 10 00 10 08), checksum over addr+data. */
const setThru = (v: number) => {
  const a = [0x10, 0x00, 0x10, 0x08];
  const sum = [...a, v].reduce((x, y) => (x + y) & 0x7f, 0);
  ve.send([0xf0, 0x41, 0x10, 0x00, 0x00, 0x00, 0x55, 0x12, ...a, v, (128 - sum) & 0x7f, 0xf7]);
};

const seen: { ch: number; note: number }[] = [];
ve.onMessage((m) => {
  if (m.length >= 3 && (m[0] & 0xf0) === 0x90 && m[2] > 0) seen.push({ ch: (m[0] & 0x0f) + 1, note: m[1] });
});

console.log('enabling the VE-500 USB-out thru (restored at the end)...');
setThru(1);
await sleep(600);
seen.length = 0;

const PLAN: [number, string][] = [[4, 'POSITIVE CONTROL (neither device listens here)'],
                                 [3, 'the VE-500 vocal target'],
                                 [2, "the MicroFreak's OWN receive channel"]];
const result: Record<number, number> = {};
for (const [ch, why] of PLAN) {
  seen.length = 0;
  for (const n of [60, 62, 64, 65, 67, 69, 71, 72]) {   // 8 notes, low velocity, short
    mf.send([0x90 | (ch - 1), n, 0x28]);
    await sleep(45);
    mf.send([0x80 | (ch - 1), n, 0]);
    await sleep(35);
  }
  await sleep(500);
  const got = seen.filter((s) => s.ch === ch).length;
  result[ch] = got;
  console.log(`  ch${ch}: sent 8, ARRIVED ${got}   ${why}`);
}

console.log('\nrestoring midi_usb_out_thru = 0 ...');
setThru(0);
await sleep(400);

// ---- verdict -----------------------------------------------------------------------------------
console.log('\n================ VERDICT ================');
if (result[4] === 0) {
  console.log('INCONCLUSIVE. The ch4 positive control did NOT arrive, so the measurement path itself');
  console.log('is not working (cable, port, thru, or the MicroFreak not relaying USB-in to DIN-out).');
  console.log('Nothing can be concluded about ch2 or ch3 from this run.');
} else if (result[3] > 0 && result[2] === 0) {
  console.log('THE HOLE FOLLOWED THE SETTING. ch3 relays, ch2 is eaten.');
  console.log('=> The VE-500 on Ch.3 is correct, and U97 (which stores Ch.2) MUST be re-stored at Ch.3.');
} else if (result[3] === 0 && result[2] > 0) {
  console.log('THE HOLE DID NOT MOVE. ch3 is still eaten, ch2 relays.');
  console.log('=> Ch.2 was right all along: U97 is correct as stored and the VE-500 should go back to Ch.2.');
} else if (result[3] > 0 && result[2] > 0) {
  console.log('NO HOLE AT ALL on either channel via this path - both relayed.');
  console.log('=> The 2026-07-28 hole may be specific to the DIN-in leg; re-run sourcing from the Circuit.');
} else {
  console.log('BOTH ch2 AND ch3 absent while the control arrived. Unexpected; do not act on this.');
}
console.log(`raw: ch4=${result[4]}/8  ch3=${result[3]}/8  ch2=${result[2]}/8`);
endMidiScript(0);
