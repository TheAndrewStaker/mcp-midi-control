/**
 * circuit-after-dark-synth1-octave-up.ts: move After Dark's Synth 1 bass up one
 * octave, on the device, touching nothing but the note byte.
 *
 * Build record: `docs/_private/rig/songs/after-dark.md` and its build log.
 *
 * ## The request
 *
 * Maintainer, at the rig, 2026-07-27, listening: *"The bass notes for synth one
 * of the After Dark Song seem to be an octave too low, please adjust that to one
 * octave up for that instrument."*
 *
 * So Synth 1 (Songsterr part 0, "Synth Bass 1") moves +12 semitones on every
 * project of the song. Stored range 27..31 (d#1..g1) becomes 39..43 (d#2..g2).
 * Nothing else moves: not the tempo (corrected to 140 earlier the same day and
 * already right), not Synth 2, not either MIDI track, not the drums.
 *
 * ## THIS IS A TASTE CORRECTION, NOT A HW-SPDSX-008 RESULT
 *
 * HW-SPDSX-008 asks whether the Circuit transmits a synth/MIDI track an octave
 * low the way its drum route provably does (HW-SPDSX-007). An ear saying "this
 * bass is an octave too low" is CONSISTENT with that and is not evidence FOR it:
 * the source part genuinely sits at d#1 (MIDI 27, ~38.9 Hz), which is a low
 * register for any rig whatever the Circuit does on the wire. A later session
 * must not read this +12 as having settled the octave question. It has not.
 *
 * ## Why byte-surgical, and why `setNoteStepVerbatim`
 *
 * Re-authoring an occupied slot needs `confirm_overwrite`, the one switch that
 * disables the occupancy gate on a device with no decoded erase. So this is the
 * same shape as the P2 midi1 clear and the tempo fix: download, patch, upload to
 * the same slot, verify with ZERO collateral tolerated.
 *
 * The edit goes through `decodeNotePattern` -> `note + 12` -> `setNoteStepVerbatim`,
 * the codec's byte-faithful re-emit. That primitive preserves the slot MASK
 * (the device does not always leading-pack it), leaves masked-off slots alone,
 * and writes gate / tie / delay / velocity / probability back exactly as read.
 * The authoring primitive `setNoteStep` would re-pack all of that and is wrong
 * here. The consequence is checkable and is checked: the whole-buffer diff must
 * consist of EXACTLY the note-lane bytes, one per sounding note, and nothing
 * else in 160,780 bytes.
 *
 * ## Refusals (each one is a stop, never a retry)
 *
 *  - Bad CRC on the read.
 *  - Project name is not the expected `AfterDark P<n>`.
 *  - Project 1's Synth 1 is NOT empty. The bass does not enter until bar 19, so
 *    P1's Synth 1 must hold nothing. Content there means the build is not what
 *    the record says and the whole pass stops.
 *  - Synth 1's note count or range on P2..P8 is not what the authoring read-back
 *    recorded (125 notes at 27..31, except P6 = 64 and P7 = 121).
 *  - Any note would leave 0..127 after the shift. It REFUSES; it never wraps.
 *  - Any diff byte outside synth1's own eight 896-byte step regions.
 *  - Any diff byte that is not a note lane (gate / tie / delay / velocity /
 *    mask / probability moving is a stop).
 *  - A backup path that already exists.
 *  - Any collateral byte or missing intended byte on read-back.
 *
 * Reads settle through the Circuit's 6-to-8s pack-manifest flush before the
 * first read and before every verify; a fast read reports stale state and on a
 * device with no erase that is the dangerous direction.
 *
 * Usage:
 *   npx tsx scripts/circuit-after-dark-synth1-octave-up.ts --offline samples/circuit-tracks/_afterdark-rest
 *   npx tsx scripts/circuit-after-dark-synth1-octave-up.ts            # dry run, reads the device
 *   npx tsx scripts/circuit-after-dark-synth1-octave-up.ts --apply
 */
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { connect, closeAllMidiConnections } from '../packages/core/src/midi/transport.js';
import { endMidiScript, exitMidiScript, reconnectMidi } from './_lib/midi-lifecycle.js';
import { downloadProject, uploadProject } from '../packages/circuit-tracks/src/ncs/uploadProject.js';
import {
  decodeNotePattern, setNoteStepVerbatim, MAX_MIDI_NOTE, type NoteStep,
} from '../packages/circuit-tracks/src/ncs/notePattern.js';
import {
  noteStepBase, NOTE_STEP_REGION, NOTE_STEP_BYTES, PATTERNS_PER_TRACK,
  STEPS_PER_PATTERN, getProjectTempo, type NoteTrack,
} from '../packages/circuit-tracks/src/ncs/format.js';

const argv = process.argv.slice(2);
const flag = (n: string): string | undefined => { const i = argv.indexOf(n); return i === -1 ? undefined : argv[i + 1]; };
const APPLY = argv.includes('--apply');
const OFFLINE = flag('--offline');
const devicePack = Number(flag('--pack') ?? '2');
const SEMITONES = Number(flag('--transpose') ?? '12');

const TARGET: NoteTrack = 'synth1';
const OTHER_TRACKS: NoteTrack[] = ['synth2', 'midi1', 'midi2'];
const NAME_OFF = 0x10;
const NAME_LEN = 0x20;
const CONNECT = { needles: ['circuit'], notFoundLeadIn: 'Circuit Tracks not found.' };

/**
 * What the 2026-07-27 authoring read-back recorded for Synth 1, project by
 * project. Asserted, not assumed: a project that does not match is a refusal,
 * because something other than this build wrote that track.
 *
 * P1 is the Intro (m1-16) and the bass does not enter until bar 19, so its
 * Synth 1 must be EMPTY. That is the one entry most worth checking rather than
 * trusting, and it is checked first.
 */
const EXPECT: Readonly<Record<number, { notes: number; lo?: number; hi?: number }>> = {
  1: { notes: 0 },
  2: { notes: 125, lo: 27, hi: 31 },
  3: { notes: 125, lo: 27, hi: 31 },
  4: { notes: 125, lo: 27, hi: 31 },
  5: { notes: 125, lo: 27, hi: 31 },
  6: { notes: 64, lo: 27, hi: 31 },
  7: { notes: 121, lo: 27, hi: 31 },
  8: { notes: 125, lo: 27, hi: 31 },
};
const SLOTS = Object.keys(EXPECT).map(Number).sort((a, b) => a - b);
const expectName = (slot: number): string => `AfterDark P${slot}`;

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const pitchName = (p: number): string => `${NOTE_NAMES[((p % 12) + 12) % 12]}${Math.floor(p / 12) - 1}`.toLowerCase();
const hex = (n: number): string => `0x${n.toString(16)}`;
const nameOf = (b: Uint8Array): string =>
  Array.from(b.slice(NAME_OFF, NAME_OFF + NAME_LEN)).map((c) => (c >= 32 && c < 127 ? String.fromCharCode(c) : '')).join('').trim();

/** The eight 896-byte step regions a note track owns. */
function trackRegions(track: NoteTrack): { from: number; to: number }[] {
  return Array.from({ length: PATTERNS_PER_TRACK }, (_, p) => {
    const from = noteStepBase(track, p);
    return { from, to: from + NOTE_STEP_REGION };
  });
}
const inRegions = (off: number, rs: { from: number; to: number }[]): boolean =>
  rs.some((r) => off >= r.from && off < r.to);

/**
 * Every byte offset in `track` that is a NOTE-NUMBER lane (slot base + 0). The
 * only offsets this script is allowed to change. Gate is +1, delay +2, velocity
 * +3, and the step header (mask, probability) is the first 4 bytes.
 */
function noteLaneOffsets(track: NoteTrack): Set<number> {
  const out = new Set<number>();
  for (let p = 0; p < PATTERNS_PER_TRACK; p++) {
    const base = noteStepBase(track, p);
    for (let s = 0; s < STEPS_PER_PATTERN; s++) {
      const stepBase = base + s * NOTE_STEP_BYTES;
      for (let n = 0; n < 6; n++) out.add(stepBase + 4 + n * 4);
    }
  }
  return out;
}
const NOTE_LANES = noteLaneOffsets(TARGET);

interface Snapshot { steps: NoteStep[][]; notes: number[]; activeSteps: number }
function snapshot(b: Uint8Array, track: NoteTrack): Snapshot {
  const steps: NoteStep[][] = [];
  const notes: number[] = [];
  let activeSteps = 0;
  for (let p = 0; p < PATTERNS_PER_TRACK; p++) {
    const decoded = decodeNotePattern(b, track, p);
    steps.push(decoded);
    for (const st of decoded) {
      if (st.notes.length > 0) activeSteps++;
      for (const sl of st.notes) notes.push(sl.note);
    }
  }
  return { steps, notes, activeSteps };
}
const rangeOf = (notes: number[]): string =>
  notes.length === 0 ? '(empty)' : `${Math.min(...notes)}..${Math.max(...notes)} (${pitchName(Math.min(...notes))}..${pitchName(Math.max(...notes))})`;

interface Plan { edits: { off: number; from: number; to: number }[]; after: Uint8Array; refusal?: string }

/** Build the +N buffer and prove it is exactly the note lanes of `TARGET`. */
function planTranspose(before: Uint8Array, snap: Snapshot): Plan {
  const after = new Uint8Array(before);
  const plan: Plan = { edits: [], after };

  // BOUNDS FIRST. Refuse rather than wrap. The codec's verbatim path bounds a
  // note lane only by the byte (0..255) so it would happily store 130; MIDI
  // stops at 127 and the device would play something the score does not say.
  for (const note of snap.notes) {
    const shifted = note + SEMITONES;
    if (shifted < 0 || shifted > MAX_MIDI_NOTE) {
      plan.refusal = `note ${note} (${pitchName(note)}) ${SEMITONES >= 0 ? '+' : ''}${SEMITONES} = ${shifted}, outside 0..${MAX_MIDI_NOTE}. Refusing; this script never wraps.`;
      return plan;
    }
  }

  for (let p = 0; p < PATTERNS_PER_TRACK; p++) {
    for (let s = 0; s < STEPS_PER_PATTERN; s++) {
      const st = snap.steps[p][s];
      if (st.notes.length === 0) continue;
      // Verbatim re-emit with ONLY the note number moved. Gate magnitude, tie
      // flag, delay, velocity, slot mask and probability are carried through
      // byte-for-byte by construction, and the diff below proves it.
      const moved: NoteStep = {
        ...st,
        notes: st.notes.map((sl) => ({ ...sl, note: sl.note + SEMITONES })),
      };
      setNoteStepVerbatim(after, TARGET, p, s, moved);
    }
  }

  const own = trackRegions(TARGET);
  for (let i = 0; i < before.length; i++) {
    if (before[i] === after[i]) continue;
    if (!inRegions(i, own)) {
      plan.refusal = `internal error: edit at ${hex(i)} falls outside ${TARGET}'s step regions.`;
      return plan;
    }
    if (!NOTE_LANES.has(i)) {
      plan.refusal = `internal error: edit at ${hex(i)} is not a note lane (it is a gate / delay / velocity / header byte). Refusing.`;
      return plan;
    }
    if (after[i] - before[i] !== SEMITONES) {
      plan.refusal = `internal error: lane ${hex(i)} moved ${before[i]} -> ${after[i]}, not by ${SEMITONES}.`;
      return plan;
    }
    plan.edits.push({ off: i, from: before[i], to: after[i] });
  }
  if (plan.edits.length !== snap.notes.length) {
    plan.refusal = `internal error: ${plan.edits.length} byte(s) changed for ${snap.notes.length} sounding note(s); expected exactly one lane per note.`;
  }
  return plan;
}

/** Decoded (not just byte) proof that only the pitch moved on synth1. */
function assertOnlyPitchMoved(was: Snapshot, now: Snapshot): string[] {
  const bad: string[] = [];
  for (let p = 0; p < PATTERNS_PER_TRACK; p++) {
    for (let s = 0; s < STEPS_PER_PATTERN; s++) {
      const a = was.steps[p][s], b = now.steps[p][s];
      if (a.slotMask !== b.slotMask) bad.push(`p${p + 1}s${s} slotMask ${a.slotMask}->${b.slotMask}`);
      if (a.probability !== b.probability) bad.push(`p${p + 1}s${s} probability ${a.probability}->${b.probability}`);
      if (a.notes.length !== b.notes.length) { bad.push(`p${p + 1}s${s} note count ${a.notes.length}->${b.notes.length}`); continue; }
      for (let i = 0; i < a.notes.length; i++) {
        const x = a.notes[i], y = b.notes[i];
        if (y.note !== x.note + SEMITONES) bad.push(`p${p + 1}s${s}n${i} note ${x.note}->${y.note} (wanted ${x.note + SEMITONES})`);
        if (y.gate !== x.gate) bad.push(`p${p + 1}s${s}n${i} GATE ${x.gate}->${y.gate}`);
        if (y.tie !== x.tie) bad.push(`p${p + 1}s${s}n${i} TIE ${x.tie}->${y.tie}`);
        if (y.delay !== x.delay) bad.push(`p${p + 1}s${s}n${i} DELAY ${x.delay}->${y.delay}`);
        if (y.velocity !== x.velocity) bad.push(`p${p + 1}s${s}n${i} VELOCITY ${x.velocity}->${y.velocity}`);
      }
    }
  }
  return bad;
}

/** Verify one project's read-back: expected bytes landed, ZERO collateral. */
function verifyBytes(before: Uint8Array, got: Uint8Array, edits: Plan['edits']): { wrong: string[]; collateral: number[] } {
  const intended = new Map(edits.map((e) => [e.off, e.to]));
  const wrong: string[] = [];
  const collateral: number[] = [];
  for (let i = 0; i < before.length; i++) {
    const want = intended.get(i);
    if (want !== undefined) { if (got[i] !== want) wrong.push(`${hex(i)}=${got[i]} (wanted ${want})`); }
    else if (got[i] !== before[i]) collateral.push(i);
  }
  return { wrong, collateral };
}

function preflight(b: Uint8Array, slot: number): { snap: Snapshot; refusal?: string } {
  const snap = snapshot(b, TARGET);
  const exp = EXPECT[slot];
  if (snap.notes.length !== exp.notes) {
    return { snap, refusal: `${TARGET} holds ${snap.notes.length} note(s), the authoring read-back recorded ${exp.notes}.` };
  }
  if (exp.notes > 0) {
    const lo = Math.min(...snap.notes), hi = Math.max(...snap.notes);
    if (lo !== exp.lo || hi !== exp.hi) {
      return { snap, refusal: `${TARGET} range is ${lo}..${hi}, the authoring read-back recorded ${exp.lo}..${exp.hi}. Either this has already been transposed, or something else wrote it.` };
    }
  }
  return { snap };
}

// ── header ───────────────────────────────────────────────────────────
console.log(`After Dark, Synth 1 (part 0 "Synth Bass 1") ${SEMITONES >= 0 ? '+' : ''}${SEMITONES} semitones`);
console.log(`Pack ${devicePack}, projects ${SLOTS.join(',')} ("AfterDark P1".."AfterDark P8")`);
console.log(`Stored 27..31 (d#1..g1) -> expected 39..43 (d#2..g2). Tempo, Synth 2, MIDI 1, MIDI 2 and the drums are NOT touched.`);
console.log(APPLY ? 'MODE: APPLY' : 'MODE: DRY RUN (nothing will be written)');
console.log('');

// Blast-radius arithmetic, before any device contact.
{
  const own = trackRegions(TARGET);
  const total = own.reduce((a, r) => a + (r.to - r.from), 0);
  console.log(`${TARGET} owns ${own.length} region(s) of ${NOTE_STEP_REGION} bytes: ${total} of 160780 (${((total / 160780) * 100).toFixed(2)}%)`);
  console.log(`  of which only the ${NOTE_LANES.size} NOTE lanes are writable by this script (${((NOTE_LANES.size / 160780) * 100).toFixed(2)}% of the file)`);
  for (const t of OTHER_TRACKS) {
    const rs = trackRegions(t);
    if (rs.some((a) => own.some((c) => a.from < c.to && c.from < a.to))) {
      console.log(`  overlaps ${t}: YES - STOP`); process.exit(1);
    }
  }
  console.log(`  overlaps synth2 / midi1 / midi2: none`);
  console.log('');
}

// ── OFFLINE ──────────────────────────────────────────────────────────
if (OFFLINE !== undefined) {
  console.log(`OFFLINE plan against ${OFFLINE} (no device, no writes)\n`);
  for (const slot of SLOTS) {
    const f = join(OFFLINE, `AfterDark_P${slot}.ncs`);
    if (!existsSync(f)) { console.log(`  P${slot}: no local copy at ${f} (skipped)`); continue; }
    const b = new Uint8Array(readFileSync(f));
    const { snap, refusal } = preflight(b, slot);
    console.log(`  P${slot}  "${nameOf(b)}"  ${TARGET} ${String(snap.notes.length).padStart(3)} notes ${rangeOf(snap.notes)}${refusal ? `  REFUSED: ${refusal}` : ''}`);
    if (refusal !== undefined || snap.notes.length === 0) continue;
    const plan = planTranspose(b, snap);
    if (plan.refusal !== undefined) { console.log(`        REFUSED: ${plan.refusal}`); continue; }
    const after = snapshot(plan.after, TARGET);
    const bad = assertOnlyPitchMoved(snap, after);
    console.log(`        ${plan.edits.length} byte(s) would change, all note lanes; after = ${rangeOf(after.notes)}; non-pitch drift: ${bad.length === 0 ? 'none' : bad.slice(0, 3).join('; ')}`);
  }
  process.exit(0);
}

// ── DEVICE ───────────────────────────────────────────────────────────
let conn = connect(CONNECT);
const reconnect = (): ReturnType<typeof connect> => { conn = reconnectMidi(conn, CONNECT); return conn; };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const SETTLE_MS = 9_000, POLL_MS = 5_000, MAX_POLLS = 6;

const readStable = async (slot: number, label: string): Promise<Awaited<ReturnType<typeof downloadProject>>> => {
  let last = await downloadProject(conn, slot - 1, { pack: devicePack - 1, reconnect });
  for (let i = 1; i <= MAX_POLLS && (!last.ok || !last.crcOk || last.bytes === undefined); i++) {
    console.log(`      ${label}: read ${i} came back ok=${last.ok} crcOk=${last.crcOk}; waiting ${POLL_MS / 1000}s and retrying (manifest flush, not a failure)`);
    await sleep(POLL_MS);
    last = await downloadProject(conn, slot - 1, { pack: devicePack - 1, reconnect });
  }
  return last;
};

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupDir = `samples/circuit-ncs/restore-afterdark-synth1-octave-${stamp}`;
if (APPLY) mkdirSync(backupDir, { recursive: true });

console.log(`settling ${SETTLE_MS / 1000}s for the pack-manifest flush before the first read...`);
await sleep(SETTLE_MS);

let written = 0, skipped = 0;
const backups: string[] = [];
for (const slot of SLOTS) {
  const tag = `P${slot}`;
  const r = await readStable(slot, tag);
  if (!r.ok || !r.crcOk || r.bytes === undefined) {
    console.log(`  ${tag}  READ FAILED (ok=${r.ok} crcOk=${r.crcOk}) ${r.error ?? ''}. Unreadable is a refusal.`);
    console.log(`\nFAIL-STOP after ${written} write(s). Projects from ${slot} on are UNTOUCHED.`);
    exitMidiScript(1);
  }
  const before = r.bytes;
  const nm = nameOf(before);
  if (nm !== expectName(slot)) {
    console.log(`  ${tag}  REFUSED: name is "${nm}", expected "${expectName(slot)}". Not touching a project this pass did not name.`);
    console.log(`\nFAIL-STOP after ${written} write(s).`);
    exitMidiScript(1);
  }

  const { snap, refusal } = preflight(before, slot);
  const others = Object.fromEntries(OTHER_TRACKS.map((t) => [t, snapshot(before, t)])) as Record<NoteTrack, Snapshot>;
  console.log(`  ${tag}  "${nm}"  CRC ok  tempo ${getProjectTempo(before)} BPM (not touched)`);
  console.log(`        ${TARGET} ${String(snap.notes.length).padStart(3)} notes ${rangeOf(snap.notes)} over ${snap.activeSteps} step(s)`
    + `   |  ` + OTHER_TRACKS.map((t) => `${t} ${others[t].notes.length}`).join(' / '));
  if (refusal !== undefined) {
    console.log(`        REFUSED: ${refusal}`);
    console.log(`\nFAIL-STOP after ${written} write(s). Projects from ${slot} on are UNTOUCHED.`);
    exitMidiScript(1);
  }
  if (snap.notes.length === 0) {
    console.log(`        VERIFIED EMPTY as the record says (the bass rests until bar 19). Nothing to do.`);
    skipped++;
    continue;
  }

  const plan = planTranspose(before, snap);
  if (plan.refusal !== undefined) {
    console.log(`        REFUSED: ${plan.refusal}`);
    console.log(`\nFAIL-STOP after ${written} write(s). Projects from ${slot} on are UNTOUCHED.`);
    exitMidiScript(1);
  }
  const afterSnap = snapshot(plan.after, TARGET);
  const drift = assertOnlyPitchMoved(snap, afterSnap);
  if (drift.length > 0) {
    console.log(`        REFUSED: ${drift.length} non-pitch change(s) in the planned buffer: ${drift.slice(0, 4).join('; ')}`);
    exitMidiScript(1);
  }
  console.log(`        plan: ${plan.edits.length} note lane(s) ${SEMITONES >= 0 ? '+' : ''}${SEMITONES} -> ${rangeOf(afterSnap.notes)}; gate/tie/delay/velocity/mask/probability unchanged in memory`);

  if (!APPLY) continue;

  const backup = `${backupDir}/pack${devicePack}-proj${String(slot).padStart(2, '0')}.ncs`;
  if (existsSync(backup)) { console.log(`        REFUSED: backup ${backup} already exists.`); exitMidiScript(1); }
  writeFileSync(backup, before);
  backups.push(backup);
  console.log(`        backup: ${backup} (${before.length} bytes, full pre-edit project)`);

  const up = await uploadProject(conn, plan.after, slot - 1, { pack: devicePack - 1, reconnect });
  if (!up.ok) {
    console.log(`        UPLOAD FAILED: ${up.error ?? 'unknown'}. Original at ${backup}`);
    console.log(`\nFAIL-STOP after ${written} write(s).`);
    exitMidiScript(1);
  }

  console.log(`        settling ${SETTLE_MS / 1000}s past the manifest-flush window before the independent read-back...`);
  await sleep(SETTLE_MS);
  const v = await readStable(slot, `${tag} verify`);
  if (!v.ok || !v.crcOk || v.bytes === undefined) {
    console.log(`        VERIFY READ FAILED (ok=${v.ok} crcOk=${v.crcOk}). Original at ${backup}`);
    exitMidiScript(1);
  }
  const { wrong, collateral } = verifyBytes(before, v.bytes, plan.edits);
  const back = snapshot(v.bytes, TARGET);
  const backDrift = assertOnlyPitchMoved(snap, back);
  const otherOk: string[] = [];
  for (const t of OTHER_TRACKS) {
    const rs = trackRegions(t);
    let diff = 0;
    for (const rr of rs) for (let i = rr.from; i < rr.to; i++) if (v.bytes[i] !== before[i]) diff++;
    otherOk.push(`${t} ${diff === 0 ? 'identical' : `${diff} BYTES CHANGED`}`);
  }
  const nameBack = nameOf(v.bytes);
  const tempoBack = getProjectTempo(v.bytes);
  console.log(`        read-back: ${plan.edits.length - wrong.length}/${plan.edits.length} intended byte(s) landed, collateral ${collateral.length}`);
  console.log(`                   ${TARGET} ${back.notes.length} notes ${rangeOf(back.notes)}; non-pitch drift: ${backDrift.length === 0 ? 'NONE' : backDrift.slice(0, 4).join('; ')}`);
  console.log(`                   ${otherOk.join(' | ')}  |  name "${nameBack}"  |  tempo ${tempoBack} BPM`);
  if (wrong.length > 0 || collateral.length > 0 || backDrift.length > 0 || nameBack !== nm || tempoBack !== getProjectTempo(before)) {
    console.log(`        VERIFY FAILED: ${wrong.length} wrong (${wrong.slice(0, 4).join(', ')}), collateral at ${collateral.slice(0, 6).map(hex).join(', ')}`);
    console.log(`        restore with ${backup}`);
    exitMidiScript(1);
  }
  console.log(`        PASS: ${plan.edits.length} byte(s) of ${before.length} changed, all note lanes, ZERO collateral.`);
  written++;
  await sleep(400);
}

console.log('');
console.log(`${APPLY ? 'APPLIED' : 'DRY RUN'}: ${written} project(s) transposed, ${skipped} correctly empty / nothing to do.`);
if (APPLY && backups.length > 0) {
  console.log('restore points:');
  for (const p of backups) console.log(`  ${p}`);
}
console.log('');
console.log('NOTE FOR THE RECORD: this is a taste-and-register correction made by ear at the');
console.log('maintainer\'s request. It is NOT a resolution of HW-SPDSX-008 (does a synth or MIDI');
console.log('track transmit an octave low?). The source part genuinely sits at d#1, which is low');
console.log('for a rig whatever the Circuit does on the wire.');
endMidiScript(0);
