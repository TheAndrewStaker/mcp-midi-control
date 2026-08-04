/**
 * circuit-read-song-state.ts: READ-ONLY state report for a run of Circuit
 * projects. Never writes, never uploads, has no `--apply` and never will.
 *
 * Answers, in one pass and from the device itself, the questions that get asked
 * after any surgical edit: what is each project called, what tempo does it
 * store, what does each note track hold and in what register, and where are the
 * synth mixer levels sitting. It exists because the edit scripts each verify
 * their OWN change, and after two edits land in sequence you want one
 * independent read that shows the combined result rather than two receipts.
 *
 * Reads settle past the Circuit's 6-to-8s pack-manifest flush before the first
 * read, so this is usable immediately after a write session without reporting
 * stale state.
 *
 * Usage:
 *   npx tsx scripts/circuit-read-song-state.ts --pack 2 --slots 1-8
 *   npx tsx scripts/circuit-read-song-state.ts --pack 5 --slots 46-55
 */
import { connect, closeAllMidiConnections } from '../packages/core/src/midi/transport.js';
import { endMidiScript, exitMidiScript, reconnectMidi } from './_lib/midi-lifecycle.js';
import { downloadProject } from '../packages/circuit-tracks/src/ncs/uploadProject.js';
import { decodeNotePattern } from '../packages/circuit-tracks/src/ncs/notePattern.js';
import {
  MIXER_SYNTH1_LEVEL, MIXER_SYNTH2_LEVEL, PATTERNS_PER_TRACK,
  getProjectTempo, NOTE_TRACKS, type NoteTrack,
} from '../packages/circuit-tracks/src/ncs/format.js';

const argv = process.argv.slice(2);
const flag = (n: string): string | undefined => { const i = argv.indexOf(n); return i === -1 ? undefined : argv[i + 1]; };
const devicePack = Number(flag('--pack') ?? '2');
const spec = flag('--slots');
if (spec === undefined) { console.error('--slots is required (e.g. --slots 1-8)'); process.exit(2); }

function parseSlots(s: string): number[] {
  const out: number[] = [];
  for (const part of s.split(',')) {
    const m = part.trim().match(/^(\d+)(?:-(\d+))?$/);
    if (!m) throw new Error(`bad --slots segment "${part}"`);
    const a = Number(m[1]), b = m[2] === undefined ? a : Number(m[2]);
    for (let i = a; i <= b; i++) out.push(i);
  }
  return [...new Set(out)].sort((x, y) => x - y);
}
const slots = parseSlots(spec);

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const pitchName = (p: number): string => `${NOTE_NAMES[((p % 12) + 12) % 12]}${Math.floor(p / 12) - 1}`.toLowerCase();
const nameOf = (b: Uint8Array): string =>
  Array.from(b.slice(0x10, 0x30)).map((c) => (c >= 32 && c < 127 ? String.fromCharCode(c) : '')).join('').trim();

function trackSummary(b: Uint8Array, track: NoteTrack): string {
  const notes: number[] = [];
  let ties = 0;
  for (let p = 0; p < PATTERNS_PER_TRACK; p++) {
    for (const st of decodeNotePattern(b, track, p)) {
      for (const sl of st.notes) { notes.push(sl.note); if (sl.tie) ties++; }
    }
  }
  if (notes.length === 0) return '(empty)';
  const lo = Math.min(...notes), hi = Math.max(...notes);
  return `${String(notes.length).padStart(3)} notes ${lo}..${hi} (${pitchName(lo)}..${pitchName(hi)})${ties > 0 ? ` ${ties} tied` : ''}`;
}

const CONNECT = { needles: ['circuit'], notFoundLeadIn: 'Circuit Tracks not found.' };
let conn = connect(CONNECT);
const reconnect = (): ReturnType<typeof connect> => { conn = reconnectMidi(conn, CONNECT); return conn; };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

console.log(`READ-ONLY state report, Pack ${devicePack}, slots ${spec}`);
console.log('settling 9s past the pack-manifest flush window before the first read...\n');
await sleep(9_000);

let read = 0;
for (const slot of slots) {
  let r = await downloadProject(conn, slot - 1, { pack: devicePack - 1, reconnect });
  if (!r.ok || !r.crcOk || r.bytes === undefined) {
    await sleep(2_000);
    r = await downloadProject(conn, slot - 1, { pack: devicePack - 1, reconnect });
  }
  if (!r.ok || !r.crcOk || r.bytes === undefined) {
    console.log(`  slot ${String(slot).padStart(2)}  READ FAILED (ok=${r.ok} crcOk=${r.crcOk}) ${r.error ?? ''}`);
    continue;
  }
  const b = r.bytes;
  read++;
  console.log(`  slot ${String(slot).padStart(2)}  "${nameOf(b)}"  ${getProjectTempo(b)} BPM  `
    + `mixer synth1=${b[MIXER_SYNTH1_LEVEL]} synth2=${b[MIXER_SYNTH2_LEVEL]}`);
  for (const t of NOTE_TRACKS) console.log(`            ${t.padEnd(7)} ${trackSummary(b, t)}`);
}
console.log(`\n${read} of ${slots.length} project(s) read. Nothing was written.`);
if (read === 0) exitMidiScript(1);
endMidiScript(0);
