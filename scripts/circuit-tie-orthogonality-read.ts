/**
 * READ BACK the tie/gate orthogonality answer from a Circuit Tracks project, and
 * say what it means. READ-ONLY: it downloads (or opens a local `.ncs`) and never
 * writes a byte to the device.
 *
 * ## What is being asked
 *
 * The per-step gate lane is decoded as `tie << 7 | gate_sixths`. Every tie in the
 * 274-file corpus sits at magnitude 96 (= 16 steps), so we have never seen a tie
 * at any other length. `circuit-tie-orthogonality-arm.ts` puts a tie at 8 steps
 * (`0x80 | 48` = 176) into the stored project; the maintainer then loads and
 * Saves it on the device, which makes the Circuit write the project out of its
 * own RAM model. Whatever comes back is the device's own opinion.
 *
 * ## Why this reads the RAW byte
 *
 * `decodeNotePattern` now splits bit 7 into a separate `tie` field, so a decoded
 * `gate` can never show the flag — reading through the decoder would hide the
 * exact thing under test. This script reads `buf[offset]` directly and does its
 * own split.
 *
 * ## The re-serialisation tell-tale (`--before`)
 *
 * A 176 read back is only meaningful if the device actually re-serialised rather
 * than echoing the file it loaded. Pass `--before <backup.ncs>` (the backup the
 * arm script wrote) and this script diffs the two images and reports:
 *   - the MIXER level bytes, which a hand-Save is known to overwrite from the
 *     live fader positions (format.ts, MIXER_SYNTH1_LEVEL) — if they moved, the
 *     save demonstrably wrote DEVICE state, not file bytes;
 *   - every other changed byte, located to (track, pattern, step, slot, lane)
 *     when it falls inside a note-pattern region.
 * A byte-identical image means the save proved nothing, and the verdict says so.
 *
 * Usage:
 *   npx tsx scripts/circuit-tie-orthogonality-read.ts
 *   npx tsx scripts/circuit-tie-orthogonality-read.ts --before samples/circuit-ncs/restore-tiegate-.../pack5-proj42.ncs
 *   npx tsx scripts/circuit-tie-orthogonality-read.ts --file samples/circuit-ncs/pack5/proj42.ncs
 *   ... --pack 5 --project 42 --track midi1 --pattern 1 --step 1 --slot 1 --gate-steps 8
 *
 * `--pack`, `--project`, `--pattern`, `--step`, `--slot` are 1-BASED, as the
 * front panel counts them.
 */
import { readFileSync, existsSync } from 'node:fs';
import {
  NCS_FILE_SIZE, NOTE_STEP_BYTES, NOTE_SLOTS_PER_STEP, STEPS_PER_PATTERN,
  PATTERNS_PER_TRACK, NOTE_TRACKS, NUM_DRUM_TRACKS, noteStepBase, drumLevelOffset,
  MIXER_SYNTH1_LEVEL, MIXER_SYNTH2_LEVEL,
  MIXER_AUDIO1_LEVEL_INFERRED, MIXER_AUDIO2_LEVEL_INFERRED,
  type NoteTrack,
} from '../packages/circuit-tracks/src/ncs/format.js';
import {
  GATE_TIE_FLAG, GATE_MAGNITUDE_MASK, MICROTICKS_PER_STEP, MAX_GATE_SIXTHS,
} from '../packages/circuit-tracks/src/ncs/notePattern.js';

const argv = process.argv.slice(2);
const flag = (n: string): string | undefined => {
  const i = argv.indexOf(n);
  return i === -1 ? undefined : argv[i + 1];
};
const devicePack = Number(flag('--pack') ?? '5');
const project = Number(flag('--project') ?? '42');
const TRACK = (flag('--track') ?? 'midi1') as NoteTrack;
const pattern1 = Number(flag('--pattern') ?? '1');
const step1 = Number(flag('--step') ?? '1');
const noteSlot1 = Number(flag('--slot') ?? '1');
const gateSteps = Number(flag('--gate-steps') ?? '8');
const localFile = flag('--file');
const beforeFile = flag('--before');

const targetSixths = gateSteps * MICROTICKS_PER_STEP;
const EXPECT_ORTHOGONAL = GATE_TIE_FLAG | targetSixths;   // 176 for 8 steps
const EXPECT_COUPLED = GATE_TIE_FLAG | MAX_GATE_SIXTHS;   // 224: forced back to full length
const EXPECT_UNTIED = targetSixths;                       // 48: tie dropped, length kept

const OFFSET = noteStepBase(TRACK, pattern1 - 1)
  + (step1 - 1) * NOTE_STEP_BYTES
  + 4                                   // step header: [slotMask, probability, 0, 0]
  + (noteSlot1 - 1) * 4
  + 1;                                  // [note, GATE LANE, delay, velocity]

const hex = (n: number): string => `0x${n.toString(16)}`;
const steps = (sixths: number): string => (sixths / MICROTICKS_PER_STEP).toFixed(2);
const nameOf = (b: Uint8Array): string =>
  Array.from(b.slice(0x10, 0x30)).map((c) => (c >= 32 && c < 127 ? String.fromCharCode(c) : '')).join('').trim();

/** Locate a file offset inside a note-pattern region, for human-readable diffs. */
function locate(off: number): string | undefined {
  for (const t of NOTE_TRACKS) {
    for (let p = 0; p < PATTERNS_PER_TRACK; p++) {
      const base = noteStepBase(t, p);
      const size = STEPS_PER_PATTERN * NOTE_STEP_BYTES;
      if (off < base || off >= base + size) continue;
      const rel = off - base;
      const s = Math.floor(rel / NOTE_STEP_BYTES);
      const within = rel % NOTE_STEP_BYTES;
      if (within < 4) return `${t} pattern ${p + 1} step ${s + 1} header[${within}]`;
      const n = Math.floor((within - 4) / 4);
      const lane = ['note', 'GATE LANE', 'delay', 'velocity'][(within - 4) % 4];
      return `${t} pattern ${p + 1} step ${s + 1} slot ${n + 1} ${lane}`;
    }
  }
  const mixer: Record<number, string> = {
    [MIXER_SYNTH1_LEVEL]: 'mixer synth1 level',
    [MIXER_SYNTH2_LEVEL]: 'mixer synth2 level',
    [MIXER_AUDIO1_LEVEL_INFERRED]: 'mixer audio1 level (inferred)',
    [MIXER_AUDIO2_LEVEL_INFERRED]: 'mixer audio2 level (inferred)',
  };
  if (mixer[off]) return mixer[off];
  for (let d = 0; d < NUM_DRUM_TRACKS; d++) if (drumLevelOffset(d) === off) return `drum ${d + 1} level`;
  return undefined;
}

async function load(): Promise<Uint8Array> {
  if (localFile) {
    if (!existsSync(localFile)) throw new Error(`no such file: ${localFile}`);
    return new Uint8Array(readFileSync(localFile));
  }
  // Imported lazily so `--file` mode needs no MIDI port at all.
  const { connect } = await import('../packages/core/src/midi/transport.js');
  const { closeAllMidiConnections, reconnectMidi } = await import('./_lib/midi-lifecycle.js');
  const { downloadProject } = await import('../packages/circuit-tracks/src/ncs/uploadProject.js');
  const CONNECT = { needles: ['circuit'], notFoundLeadIn: 'Circuit Tracks not found.' };
  let conn = connect(CONNECT);
  // Releases the old handle before reopening; a bare reassignment leaked a
  // loop-pinning input handle per reconnect.
  const reconnect = (): ReturnType<typeof connect> => { conn = reconnectMidi(conn, CONNECT); return conn; };
  try {
    let r = await downloadProject(conn, project - 1, { pack: devicePack - 1, reconnect });
    if (!r.ok || !r.crcOk || r.bytes === undefined) {
      await new Promise((res) => setTimeout(res, 1500));
      r = await downloadProject(conn, project - 1, { pack: devicePack - 1, reconnect });
    }
    if (!r.ok || !r.crcOk || r.bytes === undefined) {
      throw new Error(`read failed (ok=${r.ok} crcOk=${r.crcOk}) ${r.error ?? ''}`);
    }
    return r.bytes;
  } finally {
    // The wire work is done the moment the bytes are in hand; everything after
    // this is analysis. Release here rather than at the end of the script, so
    // the throw path frees the port too. Without it the process would sit
    // forever holding the Circuit: an open input port pins the event loop.
    closeAllMidiConnections();
  }
}

const buf = await load();
if (buf.length !== NCS_FILE_SIZE) {
  console.log(`Refusing: got ${buf.length} bytes, expected ${NCS_FILE_SIZE}.`);
  process.exit(1);
}

const raw = buf[OFFSET];
const tie = (raw & GATE_TIE_FLAG) !== 0;
const mag = raw & GATE_MAGNITUDE_MASK;

console.log(`Source      : ${localFile ?? `device pack ${devicePack} project ${project}`}`);
console.log(`Project name: "${nameOf(buf)}"`);
console.log(`Location    : ${TRACK} pattern ${pattern1} step ${step1} slot ${noteSlot1}, gate lane at ${hex(OFFSET)}`);
console.log('');
console.log(`RAW BYTE    : ${raw} (${hex(raw)}, ${raw.toString(2).padStart(8, '0')}b)`);
console.log(`  bit 7 tie : ${tie ? 'ON' : 'off'}`);
console.log(`  magnitude : ${mag} sixths = ${steps(mag)} steps`);
console.log('');

// ── Did the device actually re-serialise? ────────────────────────────────────
let reserialised: boolean | undefined;
if (beforeFile) {
  if (!existsSync(beforeFile)) { console.log(`--before: no such file: ${beforeFile}`); process.exit(1); }
  const before = new Uint8Array(readFileSync(beforeFile));
  if (before.length !== NCS_FILE_SIZE) { console.log(`--before: ${before.length} bytes, expected ${NCS_FILE_SIZE}.`); process.exit(1); }
  const diffs: number[] = [];
  for (let i = 0; i < NCS_FILE_SIZE; i++) if (before[i] !== buf[i]) diffs.push(i);
  console.log(`DIFF vs ${beforeFile}`);
  console.log(`  ${diffs.length} byte(s) differ`);
  for (const off of diffs.slice(0, 40)) {
    const where = locate(off);
    console.log(`    ${hex(off).padEnd(9)} ${String(before[off]).padStart(3)} -> ${String(buf[off]).padStart(3)}${where ? `   ${where}` : ''}`);
  }
  if (diffs.length > 40) console.log(`    ... and ${diffs.length - 40} more`);
  const mixerMoved = [MIXER_SYNTH1_LEVEL, MIXER_SYNTH2_LEVEL, MIXER_AUDIO1_LEVEL_INFERRED, MIXER_AUDIO2_LEVEL_INFERRED]
    .concat(Array.from({ length: NUM_DRUM_TRACKS }, (_, d) => drumLevelOffset(d)))
    .filter((o) => before[o] !== buf[o]);
  // The arm script's own edit is expected to be identical in both images, so any
  // diff at all is the device's handiwork.
  reserialised = diffs.length > 0;
  console.log('');
  if (mixerMoved.length > 0) {
    console.log(`  RE-SERIALISATION CONFIRMED: ${mixerMoved.length} mixer/level byte(s) moved. Those are written`);
    console.log('  from the live fader positions at save time, so the device wrote its OWN state here,');
    console.log('  not the bytes it loaded. Whatever the gate lane says below is the device speaking.');
  } else if (diffs.length > 0) {
    console.log('  RE-SERIALISATION LIKELY: bytes changed that we did not write, so the save was not a');
    console.log('  pure echo of the loaded file. The mixer tell-tale did not fire (the faders may simply');
    console.log('  have been sitting on the stored values).');
  } else {
    console.log('  ⚠ NO BYTE CHANGED AT ALL. This save is indistinguishable from an echo of the loaded');
    console.log('  file, so it does NOT prove the device re-serialised its own model. A 176 below is');
    console.log('  therefore NOT conclusive. Fall back to the Gate View route: let the DEVICE author the');
    console.log('  gate length, then save and re-read.');
  }
  console.log('');
}

// ── Verdict ──────────────────────────────────────────────────────────────────
console.log('VERDICT');
if (raw === EXPECT_ORTHOGONAL) {
  if (reserialised === false) {
    console.log(`  INCONCLUSIVE. The byte still reads ${raw}, which is exactly what we wrote, but nothing in`);
    console.log('  this file shows the device re-serialised. We may only have read our own write back.');
  } else {
    console.log(`  ORTHOGONAL — CONFIRMED. ${raw} = tie ON at ${steps(mag)} steps survived the device.`);
    console.log('  The tie flag and the gate magnitude are independent fields; the corpus-wide 96 was a');
    console.log('  habit of how ties get made, not a constraint. The decode model stands as written.');
    if (reserialised === undefined) {
      console.log('  (Re-run with --before <the arm backup> to prove the save re-serialised rather than echoed.)');
    }
  }
} else if (raw === EXPECT_COUPLED) {
  console.log(`  COUPLED. The device forced the magnitude back to ${MAX_GATE_SIXTHS} sixths (16 steps) while keeping`);
  console.log('  the tie. A tie therefore IMPLIES full length on this device, and the two fields are not');
  console.log('  independent. Authoring must not offer tie + short gate: the device will not hold it.');
} else if (raw === EXPECT_UNTIED) {
  console.log(`  TIE DROPPED. The magnitude stuck at ${mag} sixths (${steps(mag)} steps) but bit 7 was cleared. The`);
  console.log('  device only tolerates a tie at full length and silently un-ties anything shorter.');
  console.log('  Authoring must treat tie + short gate as unrepresentable, not merely unusual.');
} else if (tie) {
  console.log(`  UNEXPECTED. The tie survived but the magnitude was rewritten to ${mag} sixths (${steps(mag)} steps),`);
  console.log(`  which is neither the ${targetSixths} we wrote nor the ${MAX_GATE_SIXTHS} the corpus always shows. The device is`);
  console.log('  quantising or clamping in a way the model does not describe. Do not ship a tie/gate');
  console.log('  claim on the current model; capture this value and re-derive.');
} else {
  console.log(`  UNEXPECTED. Tie cleared AND magnitude rewritten to ${mag} sixths (${steps(mag)} steps). Neither field`);
  console.log('  behaved as modelled. Check first that the right project was loaded and saved, then treat');
  console.log('  the gate-lane decode as open again.');
}
console.log('');
console.log('Reference: 176 = orthogonal, 224 = coupled (tie forces full length), 48 = tie dropped.');
process.exit(0);
