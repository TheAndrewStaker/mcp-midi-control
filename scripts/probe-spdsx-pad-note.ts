/**
 * Identify which SPD-SX PAD a given MIDI note triggers, by ear.
 *
 * ## Why this exists
 *
 * The SPD-SX per-pad MIDI NOTE# is a per-pad, PER-KIT setting, not a fixed
 * ascending default. Nothing on the wire reports it, and MINIMAL kits carry no
 * `<NoteNum>` in their file either, so for those kits the mapping is genuinely
 * unknowable without asking the device or the player. Authoring against an
 * ASSUMED map is what put a snare part on a cymbal pad (note 51) and a perc
 * accent on a china (note 68) across six stored projects.
 *
 * This turns the assumption into a measurement.
 *
 * ## Routing note (read before wondering why nothing sounds)
 *
 * The SPD-SX is NOT a USB device in this rig: it hangs off the Circuit's MIDI
 * DIN out. So the note is sent to the CIRCUIT's port on the MIDI-2 track
 * channel, and reaches the SPD-SX only if the Circuit forwards it. If you hear
 * nothing, that forwarding is off (Circuit: MIDI Thru / the MIDI-2 track's
 * output setting) — that is a rig setting, not a bug in this script.
 *
 * ## Deliberately one note per invocation
 *
 * Probe scripts that depend on the maintainer HEARING something must never use
 * a timer to advance (project rule): you cannot reliably watch/listen on a
 * countdown. One note per run, paced by the human, is the interactive form that
 * survives being interrupted mid-listen.
 *
 * Usage:
 *   npx tsx scripts/probe-spdsx-pad-note.ts 68           # one note
 *   npx tsx scripts/probe-spdsx-pad-note.ts 68 --repeat 3
 *   npx tsx scripts/probe-spdsx-pad-note.ts 68 --channel 4 --port circuit
 */
import { connect } from '../packages/core/src/midi/transport.js';

const argv = process.argv.slice(2);
const flag = (n: string): string | undefined => {
  const i = argv.indexOf(n);
  return i === -1 ? undefined : argv[i + 1];
};

const note = Number(argv[0]);
if (!Number.isInteger(note) || note < 0 || note > 127) {
  console.error('Usage: npx tsx scripts/probe-spdsx-pad-note.ts <note 0..127> [--channel 4] [--repeat 1] [--port circuit]');
  process.exit(2);
}
const channel = Number(flag('--channel') ?? '4');       // Circuit MIDI-2 track
const repeat = Number(flag('--repeat') ?? '1');
const portNeedle = flag('--port') ?? 'circuit';
const velocity = Number(flag('--velocity') ?? '110');

const conn = connect({ needles: [portNeedle], notFoundLeadIn: `No MIDI port matching "${portNeedle}".` });
const status = 0x90 | ((channel - 1) & 0x0f);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

console.log(`Sending note ${note} (vel ${velocity}) on channel ${channel} to "${portNeedle}" x${repeat}.`);
console.log('Listen to the SPD-SX and note WHICH PAD / sound fires.\n');

for (let i = 0; i < repeat; i++) {
  conn.send([status, note, velocity]);
  await sleep(250);
  conn.send([status, note, 0]);        // note-off as velocity-0 note-on
  if (i < repeat - 1) await sleep(500);
}

console.log(`Done. If nothing sounded, the Circuit is not forwarding USB -> MIDI OUT on channel ${channel}.`);
console.log('Re-run with a different note to map the next pad.');
process.exit(0);
