/**
 * Circuit Tracks ch1 PROGRAM CHANGE COLLISION probe. Self-validating: needs no
 * human to watch the device.
 *
 * The question. Moving the Hydrasynth to ch1 (so the Circuit's Synth 1 track
 * drives it, layered with the Circuit's own voice) is only safe if a Program
 * Change addressed to the Hydra does not ALSO retarget the Circuit's own Synth 1
 * patch. The Programmer's Reference implies it does ("send a Program Change with
 * the desired patch number (0-63) to a synth MIDI channel"), but implication is
 * not evidence, and the whole per-song recall map depends on the answer.
 *
 * The method. The Circuit answers a "Current Patch Dump Request" with the full
 * 350-byte working patch. So: dump Synth 1, send a PC on ch1, dump again, diff.
 * A changed dump is proof the Circuit consumed the PC. No ears, no eyes.
 *
 *   Current Patch Dump Request:  F0 00 20 29 01 64 40 <location> F7
 *     00 20 29 = Novation, 01 = product type (synth), 64 = Circuit Tracks,
 *     40 = command (dump request), location 00 = Synth 1 / 01 = Synth 2.
 *
 * SAFETY. This sends one Program Change, which loads a stored patch over Synth
 * 1's working buffer. Stored patches in flash are untouched. Before doing so it
 * writes the ORIGINAL patch dump to samples/ as a byte-exact restore artifact,
 * so the prior working buffer can be put back with a Replace Current Patch if it
 * held unsaved edits.
 *
 * Run: npx tsx scripts/probe-circuit-ch1-pc-collision.ts [pcProgram]
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { connect } from '../packages/core/src/midi/transport.js';
import { endMidiScript } from './_lib/midi-lifecycle.js';

const pcProgram = Number(process.argv[2] ?? '7');

const DUMP_REQUEST = (location: number): number[] => [0xf0, 0x00, 0x20, 0x29, 0x01, 0x64, 0x40, location, 0xf7];
const isNovation = (b: readonly number[]): boolean =>
  b[1] === 0x00 && b[2] === 0x20 && b[3] === 0x29 && b[4] === 0x01 && b[5] === 0x64;

const hex = (b: readonly number[]): string => b.map((x) => x.toString(16).padStart(2, '0')).join(' ');
const ascii = (b: readonly number[]): string =>
  b.map((x) => (x >= 0x20 && x <= 0x7e ? String.fromCharCode(x) : '.')).join('');

const conn = connect({ needles: ['circuit'], notFoundLeadIn: 'Circuit Tracks not found in the MIDI device list.' });

async function dumpSynth1(): Promise<number[] | undefined> {
  const waiter = conn.receiveSysExMatching(isNovation, 3000).catch(() => undefined);
  conn.send(DUMP_REQUEST(0x00));
  return waiter;
}

console.log('[1] Dumping Synth 1 working patch (BEFORE)');
const before = await dumpSynth1();
if (before === undefined) {
  console.log('    NO REPLY. The Circuit did not answer a Current Patch Dump Request.');
  console.log('    Without a baseline there is nothing to diff, so the probe cannot run.');
  process.exit(1);
}
console.log(`    ${before.length} bytes`);
console.log(`    name region: "${ascii(before.slice(9, 25))}"`);

mkdirSync('samples/circuit-restore', { recursive: true });
const restorePath = 'samples/circuit-restore/synth1-before-pc-probe.syx';
writeFileSync(restorePath, Buffer.from(before));
console.log(`    original saved byte-exact -> ${restorePath}`);
console.log('    (re-sending that file as a Replace Current Patch restores this working buffer)\n');

console.log(`[2] Sending Program Change ${pcProgram} on channel 1`);
conn.send([0xc0, pcProgram]);
if (conn.lastSendError !== undefined) console.log(`    SEND FAILED: ${conn.lastSendError.message}`);
await new Promise((r) => setTimeout(r, 500));

console.log('\n[3] Dumping Synth 1 working patch (AFTER)');
const after = await dumpSynth1();
if (after === undefined) {
  console.log('    NO REPLY on the second dump. Inconclusive.');
  process.exit(1);
}
console.log(`    ${after.length} bytes`);
console.log(`    name region: "${ascii(after.slice(9, 25))}"`);

console.log('\n--- verdict ---');
const same = before.length === after.length && before.every((b, i) => b === after[i]);
if (same) {
  console.log('IDENTICAL. The Circuit did NOT change its Synth 1 patch on a ch1 Program Change.');
  console.log('=> NO COLLISION. The Hydra can sit on ch1 and take PCs without disturbing the Circuit.');
} else {
  let firstDiff = -1;
  let diffCount = 0;
  for (let i = 0; i < Math.max(before.length, after.length); i++) {
    if (before[i] !== after[i]) { if (firstDiff === -1) firstDiff = i; diffCount++; }
  }
  console.log(`CHANGED. ${diffCount} bytes differ, first at offset ${firstDiff}.`);
  console.log('=> COLLISION CONFIRMED. A Program Change on ch1 retargets the Circuit\'s OWN Synth 1');
  console.log('   patch as well as anything else listening on ch1 (the Hydra, once moved).');
  console.log(`\n   before[${firstDiff}..]: ${hex(before.slice(firstDiff, firstDiff + 12))}`);
  console.log(`   after [${firstDiff}..]: ${hex(after.slice(firstDiff, firstDiff + 12))}`);
}
endMidiScript();
