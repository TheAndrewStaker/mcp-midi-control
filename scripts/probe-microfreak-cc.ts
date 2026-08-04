/**
 * MicroFreak CC sweep probe. Verifies the PUBLISHED control-change chart against
 * the actual device, one CC at a time, by ear.
 *
 * Why one at a time: firing a batch produces a sound the listener cannot
 * attribute to any particular controller, which is the "one capture per
 * hypothesis" rule applied to audio. Each run sweeps exactly ONE cc so the
 * answer is unambiguous.
 *
 * The sweep ramps 0 -> 127 -> 0 over a few seconds while a note is held, so a
 * continuous parameter (cutoff, resonance) is obvious by ear rather than a
 * single step that might not be audible at all.
 *
 * NOT destructive, but NOT inert either: CC edits the working buffer, so the
 * current preset will sound changed until it is reloaded. Nothing is written to
 * the device's memory. Reload the preset (or press its encoder) to restore.
 *
 * Run: npx tsx scripts/probe-microfreak-cc.ts <cc> [channel] [note] [seconds]
 */
import { connect } from '../packages/core/src/midi/transport.js';

const cc = Number(process.argv[2]);
const channel = Number(process.argv[3] ?? '3');
const note = Number(process.argv[4] ?? '48');
const seconds = Number(process.argv[5] ?? '6');

/** The published chart (midi.guide / Arturia). What this probe is testing. */
const PUBLISHED: Record<number, string> = {
  5: 'Glide', 9: 'Oscillator Type', 10: 'Oscillator Wave', 12: 'Oscillator Timbre',
  13: 'Oscillator Shape', 23: 'Filter Cutoff', 83: 'Filter Resonance',
  24: 'Cycling Env Amount', 28: 'Cycling Env Hold', 102: 'Cycling Env Rise',
  103: 'Cycling Env Fall', 91: 'Arp/Seq Rate (free)', 92: 'Arp/Seq Rate (sync)',
  93: 'LFO Rate (free)', 94: 'LFO Rate (sync)', 105: 'Envelope Attack',
  106: 'Envelope Decay/Release', 29: 'Envelope Sustain', 26: 'Filter Amount',
  64: 'Keyboard Hold (toggle)', 2: 'Keyboard Spice',
};

if (!Number.isFinite(cc)) {
  console.error('usage: probe-microfreak-cc.ts <cc> [channel] [note] [seconds]');
  console.error('known CCs: ' + Object.entries(PUBLISHED).map(([n, l]) => `${n}=${l}`).join(', '));
  process.exit(1);
}

const conn = connect({ needles: ['microfreak', 'arturia'], notFoundLeadIn: 'MicroFreak not found.' });
const label = PUBLISHED[cc] ?? '(not in the published chart)';
console.log(`CC ${cc} — published as: ${label}`);
console.log(`Holding note ${note} on channel ${channel}, sweeping 0 -> 127 -> 0 over ${seconds}s.\n`);

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const status = 0xb0 | (channel - 1);

conn.send([0x90 | (channel - 1), note, 100]);
const steps = 64;
const stepMs = Math.max(1, Math.round((seconds * 1000) / (steps * 2)));
for (let i = 0; i <= steps; i++) {
  conn.send([status, cc, Math.round((i / steps) * 127)]);
  await sleep(stepMs);
}
for (let i = steps; i >= 0; i--) {
  conn.send([status, cc, Math.round((i / steps) * 127)]);
  await sleep(stepMs);
}
conn.send([0x80 | (channel - 1), note, 0]);

console.log('Sweep done. Did anything change, and did it match the published label?');
console.log('(Reload the preset on the device to discard this working-buffer edit.)');
process.exit(0);
