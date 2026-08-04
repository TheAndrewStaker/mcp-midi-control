/**
 * After Dark MIDI 1 census, READ-ONLY. Downloads projects and reports what each
 * one's midi1 track actually holds. Writes NOTHING: `uploadProject` is
 * deliberately not imported, so this file cannot alter the card.
 *
 * ## Why this exists
 *
 * `circuit-after-dark-midi1-octave-up.ts` transposes P3 / P5 / P8 on the
 * stated belief that the OTHER five projects have no midi1 content at all
 * (P1 / P4 / P6 / P7 never had any, P2's was deliberately cleared by
 * `circuit-after-dark-p2-clear-midi1.ts`). That belief decides the scope of a
 * write on a device with no decoded erase, so it gets measured rather than
 * assumed: if a project that is supposed to be empty is holding notes, the
 * transpose scope is wrong and the run should not happen.
 *
 * It also reports the three chorus projects, which makes it a cheap way to
 * confirm the card's current range before choosing the `--expect` argument for
 * the transpose.
 *
 * Reads settle through the Circuit's 6-to-8s pack-manifest flush; a fast read
 * reports stale state, and stale state read as truth is what makes a scope
 * decision wrong.
 *
 * Run:
 *   npx tsx scripts/circuit-after-dark-midi1-census.ts               # all 8 projects
 *   npx tsx scripts/circuit-after-dark-midi1-census.ts --slots 1,2,4,6,7
 */
import { connect } from '../packages/core/src/midi/transport.js';
import { endMidiScript, exitMidiScript, reconnectMidi } from './_lib/midi-lifecycle.js';
import { downloadProject } from '../packages/circuit-tracks/src/ncs/uploadProject.js';
import { decodeNotePattern } from '../packages/circuit-tracks/src/ncs/notePattern.js';
import {
  PATTERNS_PER_TRACK, getProjectTempo, type NoteTrack,
} from '../packages/circuit-tracks/src/ncs/format.js';

const argv = process.argv.slice(2);
const flag = (n: string): string | undefined => { const i = argv.indexOf(n); return i === -1 ? undefined : argv[i + 1]; };
const devicePack = Number(flag('--pack') ?? '2');
const SLOTS = (flag('--slots') ?? '1,2,3,4,5,6,7,8').split(',').map((s) => Number(s.trim()));

const TRACKS: NoteTrack[] = ['synth1', 'synth2', 'midi1', 'midi2'];
const NAME_OFF = 0x10;
const NAME_LEN = 0x20;
const CONNECT = { needles: ['circuit'], notFoundLeadIn: 'Circuit Tracks not found.' };

/** Which projects the build record says carry the chorus melody on midi1. */
const CHORUS = new Set([3, 5, 8]);

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const pitchName = (p: number): string => `${NOTE_NAMES[((p % 12) + 12) % 12]}${Math.floor(p / 12) - 1}`;
const nameOf = (b: Uint8Array): string =>
  Array.from(b.slice(NAME_OFF, NAME_OFF + NAME_LEN)).map((c) => (c >= 32 && c < 127 ? String.fromCharCode(c) : '')).join('').trim();

function noteCount(b: Uint8Array, track: NoteTrack): number[] {
  const notes: number[] = [];
  for (let p = 0; p < PATTERNS_PER_TRACK; p++) {
    for (const st of decodeNotePattern(b, track, p)) for (const sl of st.notes) notes.push(sl.note);
  }
  return notes;
}
const rangeOf = (n: number[]): string =>
  n.length === 0 ? '(empty)' : `${Math.min(...n)}..${Math.max(...n)} ${pitchName(Math.min(...n))}..${pitchName(Math.max(...n))}`;

console.log(`After Dark MIDI 1 census, pack ${devicePack}, projects ${SLOTS.join(',')} — READ ONLY\n`);

let conn = connect(CONNECT);
const reconnect = (): ReturnType<typeof connect> => { conn = reconnectMidi(conn, CONNECT); return conn; };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const SETTLE_MS = 9_000, POLL_MS = 5_000, MAX_POLLS = 6;

console.log(`settling ${SETTLE_MS / 1000}s for the pack-manifest flush before the first read...\n`);
await sleep(SETTLE_MS);

let unexpected = 0;
for (const slot of SLOTS) {
  let r = await downloadProject(conn, slot - 1, { pack: devicePack - 1, reconnect });
  for (let i = 1; i <= MAX_POLLS && (!r.ok || !r.crcOk || r.bytes === undefined); i++) {
    await sleep(POLL_MS);
    r = await downloadProject(conn, slot - 1, { pack: devicePack - 1, reconnect });
  }
  if (!r.ok || !r.crcOk || r.bytes === undefined) {
    console.log(`  P${slot}  READ FAILED (ok=${r.ok} crcOk=${r.crcOk}). Unreadable is not "empty".`);
    unexpected++;
    continue;
  }
  const b = r.bytes;
  const per = Object.fromEntries(TRACKS.map((t) => [t, noteCount(b, t)])) as Record<NoteTrack, number[]>;
  const m1 = per.midi1;
  const shouldHave = CHORUS.has(slot);
  const surprising = shouldHave ? m1.length === 0 : m1.length > 0;
  if (surprising) unexpected++;
  console.log(
    `  P${slot}  "${nameOf(b)}"  ${getProjectTempo(b)} BPM   `
    + `midi1 ${String(m1.length).padStart(3)} ${rangeOf(m1).padEnd(22)}`
    + `  | synth1 ${per.synth1.length} / synth2 ${per.synth2.length} / midi2 ${per.midi2.length}`
    + `  ${surprising ? (shouldHave ? '<< EXPECTED THE CHORUS LINE, FOUND NONE' : '<< EXPECTED EMPTY, FOUND NOTES') : ''}`,
  );
  await sleep(400);
}

console.log('');
console.log(unexpected === 0
  ? 'All projects match the build record: midi1 content in P3/P5/P8 only.'
  : `${unexpected} project(s) did not match the build record. Do not transpose until this is understood.`);
if (unexpected > 0) exitMidiScript(1);
endMidiScript(0);
