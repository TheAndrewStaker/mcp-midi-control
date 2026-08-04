/**
 * circuit-after-dark-midi1-octave-up.ts: move After Dark's MIDI 1 chorus line up
 * one octave, on the device, touching nothing but the note byte.
 *
 * Build record: `docs/_private/rig/songs/after-dark.md` and its build log.
 * Precedent, and the shape this is copied from: `circuit-after-dark-synth1-octave-up.ts`.
 *
 * ## The request
 *
 * Maintainer, at the rig, 2026-07-27, listening: *"you actually made the melody
 * that I can hear played through the micro freak super low. It should be up by
 * at least one octave maybe even two, it might be supposed to be the exact same
 * octave as the intro."* He then asked for something stronger: put the actual
 * VOCAL part on MIDI 1, so the notes he hears are the notes his voice is meant
 * to glide to.
 *
 * ## Why +12 satisfies BOTH asks, and is not a taste guess
 *
 * The tab (Songsterr 501859 rev 4102120) has **no vocal part**: seven parts, and
 * the instrument names AND the contributors' own track names were both checked,
 * because Songsterr files vocal lines under arbitrary instruments (Schism's
 * vocal is a `Bassoon`). Nothing here is a voice.
 *
 * What the roster DOES contain is one melody stated three times
 * (`scripts/songsterr-roster-audit.ts` + `scripts/songsterr-after-dark-melody-compare.ts`):
 *
 *   part 5  piano "Track 1"   Intro m1-16       84 onsets   51..65  (D#3..F4)
 *   part 4  Lead 1 (square)   m19-130           401 onsets  43..65  (G2..F4)
 *   part 3  Lead 2 (sawtooth) choruses only     252 onsets  39..53  (D#2..F3)
 *
 * and the three are provably the same line:
 *
 *   - part 3 vs part 4: **252 of 252** shared onsets, interval **CONSTANT +12**.
 *   - part 5 (Intro) vs part 4's Chorus 1, slid to a common origin: 84 paired
 *     onsets, **0 rhythm mismatches**, interval **CONSTANT +0**. The intro
 *     melody IS the chorus melody, note for note, in the same octave.
 *   - all three choruses are byte-identical repeats of each other (0 mismatches).
 *
 * So "the exact same octave as the intro" resolves to **+12**, checked rather
 * than guessed, and it lands MIDI 1 on 51..65 = D#3..F4 = exactly part 5's
 * intro register AND exactly part 4's chorus register. Transposing part 3 by
 * +12 therefore produces the square lead's chorus content note for note: the
 * "use the other part instead" ask and the "raise the octave" ask are the SAME
 * write, so neither has to be guessed at.
 *
 * **What this does NOT claim.** It does not claim this line is his vocal melody.
 * It cannot: the line is stated by the INSTRUMENTAL intro, which has no singing
 * over it, so the tab is not asserting these are sung notes. It is the song's
 * melody and the best available pitch target; it is not "the exact vocal notes"
 * because the source does not contain them.
 *
 * ## The SECOND +12, and why the expected range is now an ARGUMENT
 *
 * 2026-07-28: a two-port capture measured what the Circuit actually TRANSMITS
 * from a MIDI track, and it is not what it stores. Stored 51..65 arrived on the
 * wire as **39..53**: minus twelve at BOTH ends, a constant offset, not a
 * clamp and not a fold. The Circuit's MIDI-track note numbering sits an octave
 * below the wire.
 *
 * That measurement inverts the arithmetic. The maintainer's voice sits at
 * D#3..F4, and "D#3..F4" is a statement about the NOTES THAT ARRIVE, because
 * the VE-500 hears the wire, not the card. So the wire must carry 51..65, and
 * storage must therefore be **63..77 (D#4..F5)**: one more octave up.
 *
 * The first run's guard hard-coded the pre-transpose range 39..53. After that
 * run midi1 holds 51..65, so re-running would refuse, correctly. The fix is NOT
 * to relax the guard, which is the only thing standing between a mis-aimed
 * re-run and a silently double-transposed melody on a device with no erase.
 * Instead the expected range became an EXPLICIT ARGUMENT: `--expect lo..hi`,
 * defaulting to the original 39..53. The refusal still fires on ANY range that
 * is not the one named, so the caller has to state what they believe is on the
 * card and be right about it. A wrong `--expect` fails exactly as loudly as no
 * `--expect` did; what changed is that the correct range can be stated, not
 * that a wrong one is tolerated.
 *
 * The 2026-07-28 run was therefore:
 *   npx tsx scripts/circuit-after-dark-midi1-octave-up.ts --expect 51..65 --apply
 *
 * ## Scope: the three choruses only
 *
 * P3, P5, P8. Part 4 also sounds in the verses (m19-34, m51-66, 48 onsets,
 * A#2..D#3) and the bridge (m99-114, 53 onsets, G2..D3), on DIFFERENT material
 * from the chorus. Back-filling those into P2 / P4 / P7 would run the VE-500
 * retune across the whole song, which the maintainer explicitly rejected: the
 * record uses pitch correction only in the chorus, and *"the 48 silent bars are
 * not a gap in the arrangement, they are the arrangement"* (after-dark.md,
 * Intent). That is a decision for him, not for this script, so this script
 * touches only the three projects that already hold the line.
 *
 * ## Why byte-surgical, and why `setNoteStepVerbatim`
 *
 * Re-authoring an occupied slot needs `confirm_overwrite`, the one switch that
 * disables the occupancy gate on a device with no decoded erase. So: download,
 * patch, upload to the same slot, verify with ZERO collateral tolerated.
 * `setNoteStepVerbatim` re-emits gate / tie / delay / velocity / slot mask /
 * probability byte-for-byte; `setNoteStep` would re-pack them and is wrong here.
 * The consequence is checkable and is checked: the whole-buffer diff must be
 * EXACTLY the note-lane bytes, one per sounding note, and nothing else.
 *
 * ## Refusals (each one is a stop, never a retry)
 *
 *  - Bad CRC on the read.
 *  - Project name is not the expected `AfterDark P<n>`.
 *  - midi1 does not hold exactly 84 notes at the expected range (`--expect`,
 *    default 39..53): already transposed, or something else wrote it.
 *  - Any note would leave 0..127 after the shift. It REFUSES; it never wraps.
 *  - Any diff byte outside midi1's own eight 896-byte step regions.
 *  - Any diff byte that is not a note lane.
 *  - A backup path that already exists.
 *  - Any collateral byte or missing intended byte on read-back.
 *  - synth1 / synth2 / midi2 not byte-identical on read-back.
 *
 * Reads settle through the Circuit's 6-to-8s pack-manifest flush before the
 * first read and before every verify; a fast read reports stale state and on a
 * device with no erase that is the dangerous direction.
 *
 * Usage:
 *   npx tsx scripts/circuit-after-dark-midi1-octave-up.ts                        # dry run, expects 39..53
 *   npx tsx scripts/circuit-after-dark-midi1-octave-up.ts --expect 51..65        # dry run against a transposed card
 *   npx tsx scripts/circuit-after-dark-midi1-octave-up.ts --expect 51..65 --apply
 */
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { connect } from '../packages/core/src/midi/transport.js';
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
const devicePack = Number(flag('--pack') ?? '2');
const SEMITONES = Number(flag('--transpose') ?? '12');

const TARGET: NoteTrack = 'midi1';
const OTHER_TRACKS: NoteTrack[] = ['synth1', 'synth2', 'midi2'];
const NAME_OFF = 0x10;
const NAME_LEN = 0x20;
const CONNECT = { needles: ['circuit'], notFoundLeadIn: 'Circuit Tracks not found.' };

/**
 * What the card is expected to be holding BEFORE this run, as an explicit
 * claim the caller has to get right.
 *
 * The default is the 2026-07-27 authoring read-back: the three choruses carry
 * part 3 (84 onsets, 39..53); every other project's midi1 is empty, P2's
 * deliberately cleared. `--expect lo..hi` restates that range for a card that
 * has already been transposed once. The GUARD IS UNCHANGED either way: an
 * actual range that is not the expected one is a hard refusal, so naming the
 * wrong range fails just as loudly as naming none. This exists so a correct
 * re-run is possible, NOT so a mis-aimed one becomes possible.
 */
const EXPECT_NOTES = 84;
const EXPECT_RANGE = ((): { lo: number; hi: number } => {
  const raw = flag('--expect');
  if (raw === undefined) return { lo: 39, hi: 53 };
  const m = /^(\d+)\.\.(\d+)$/.exec(raw.trim());
  if (m === null) {
    console.error(`--expect must look like "lo..hi" (e.g. 51..65), got "${raw}".`);
    process.exit(1);
  }
  const lo = Number(m[1]), hi = Number(m[2]);
  if (lo > hi) { console.error(`--expect lo (${lo}) is above hi (${hi}).`); process.exit(1); }
  if (lo < 0 || hi > MAX_MIDI_NOTE) {
    console.error(`--expect ${lo}..${hi} is outside 0..${MAX_MIDI_NOTE}; that cannot be on the card.`);
    process.exit(1);
  }
  return { lo, hi };
})();

/**
 * Where the transpose lands. Asserted BEFORE any device traffic so an
 * out-of-range target is refused at the argument boundary, not discovered
 * three reads in. `planTranspose` re-checks every individual note against
 * 0..127 as well; this is the cheap early stop, not the only one.
 */
const TARGET_RANGE = { lo: EXPECT_RANGE.lo + SEMITONES, hi: EXPECT_RANGE.hi + SEMITONES };
if (TARGET_RANGE.lo < 0 || TARGET_RANGE.hi > MAX_MIDI_NOTE) {
  console.error(
    `${EXPECT_RANGE.lo}..${EXPECT_RANGE.hi} ${SEMITONES >= 0 ? '+' : ''}${SEMITONES} = `
    + `${TARGET_RANGE.lo}..${TARGET_RANGE.hi}, outside 0..${MAX_MIDI_NOTE}. Refusing; this script never wraps.`,
  );
  process.exit(1);
}

const EXPECT: Readonly<Record<number, { notes: number; lo?: number; hi?: number }>> = {
  3: { notes: EXPECT_NOTES, lo: EXPECT_RANGE.lo, hi: EXPECT_RANGE.hi },
  5: { notes: EXPECT_NOTES, lo: EXPECT_RANGE.lo, hi: EXPECT_RANGE.hi },
  8: { notes: EXPECT_NOTES, lo: EXPECT_RANGE.lo, hi: EXPECT_RANGE.hi },
};
const SLOTS = Object.keys(EXPECT).map(Number).sort((a, b) => a - b);
const expectName = (slot: number): string => `AfterDark P${slot}`;

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const pitchName = (p: number): string => `${NOTE_NAMES[((p % 12) + 12) % 12]}${Math.floor(p / 12) - 1}`;
const hex = (n: number): string => `0x${n.toString(16)}`;
const nameOf = (b: Uint8Array): string =>
  Array.from(b.slice(NAME_OFF, NAME_OFF + NAME_LEN)).map((c) => (c >= 32 && c < 127 ? String.fromCharCode(c) : '')).join('').trim();

function trackRegions(track: NoteTrack): { from: number; to: number }[] {
  return Array.from({ length: PATTERNS_PER_TRACK }, (_, p) => {
    const from = noteStepBase(track, p);
    return { from, to: from + NOTE_STEP_REGION };
  });
}
const inRegions = (off: number, rs: { from: number; to: number }[]): boolean =>
  rs.some((r) => off >= r.from && off < r.to);

/** Every offset in `track` that is a NOTE-NUMBER lane. The only writable set. */
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

function planTranspose(before: Uint8Array, snap: Snapshot): Plan {
  const after = new Uint8Array(before);
  const plan: Plan = { edits: [], after };

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
      const moved: NoteStep = { ...st, notes: st.notes.map((sl) => ({ ...sl, note: sl.note + SEMITONES })) };
      setNoteStepVerbatim(after, TARGET, p, s, moved);
    }
  }

  const own = trackRegions(TARGET);
  for (let i = 0; i < before.length; i++) {
    if (before[i] === after[i]) continue;
    if (!inRegions(i, own)) { plan.refusal = `internal error: edit at ${hex(i)} falls outside ${TARGET}'s step regions.`; return plan; }
    if (!NOTE_LANES.has(i)) { plan.refusal = `internal error: edit at ${hex(i)} is not a note lane.`; return plan; }
    if (after[i] - before[i] !== SEMITONES) { plan.refusal = `internal error: lane ${hex(i)} moved ${before[i]} -> ${after[i]}, not by ${SEMITONES}.`; return plan; }
    plan.edits.push({ off: i, from: before[i], to: after[i] });
  }
  if (plan.edits.length !== snap.notes.length) {
    plan.refusal = `internal error: ${plan.edits.length} byte(s) changed for ${snap.notes.length} sounding note(s); expected exactly one lane per note.`;
  }
  return plan;
}

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
      return { snap, refusal: `${TARGET} range is ${lo}..${hi} (${pitchName(lo)}..${pitchName(hi)}), the expected range is ${exp.lo}..${exp.hi}`
        + `${flag('--expect') === undefined ? ' (the 2026-07-27 authoring read-back; pass --expect lo..hi if the card has moved since)' : ' (from --expect)'}.`
        + ` Either this has already been transposed, or something else wrote it. Not guessing.` };
    }
  }
  return { snap };
}

// ── header ───────────────────────────────────────────────────────────
console.log(`After Dark, MIDI 1 (part 3 "Lead 2 (sawtooth)") ${SEMITONES >= 0 ? '+' : ''}${SEMITONES} semitones`);
console.log(`Pack ${devicePack}, the three chorus projects ${SLOTS.join(',')} ("AfterDark P3", "P5", "P8")`);
console.log(`Expecting stored ${EXPECT_RANGE.lo}..${EXPECT_RANGE.hi} (${pitchName(EXPECT_RANGE.lo)}..${pitchName(EXPECT_RANGE.hi)})`
  + ` -> writing ${TARGET_RANGE.lo}..${TARGET_RANGE.hi} (${pitchName(TARGET_RANGE.lo)}..${pitchName(TARGET_RANGE.hi)})`
  + `${flag('--expect') === undefined ? '   [default expectation, --expect not given]' : '   [--expect given]'}`);
console.log(`  the Circuit transmits MIDI-track notes 12 SEMITONES BELOW what it stores (two-port capture, 2026-07-28),`);
console.log(`  so stored ${TARGET_RANGE.lo}..${TARGET_RANGE.hi} arrives on the wire as ${TARGET_RANGE.lo - 12}..${TARGET_RANGE.hi - 12} (${pitchName(TARGET_RANGE.lo - 12)}..${pitchName(TARGET_RANGE.hi - 12)}), which is what the MicroFreak plays`);
console.log(`  (as of 2026-07-28 the VE-500's retune target is SYNTH 2 on ch2, not this track: the MicroFreak absorbs ch3 and does not relay it)`);
console.log(`Synth 1, Synth 2, MIDI 2, the drums, the tempo and every other project are NOT touched.`);
console.log(APPLY ? 'MODE: APPLY' : 'MODE: DRY RUN (nothing will be written)');
console.log('');

{
  const own = trackRegions(TARGET);
  const total = own.reduce((a, r) => a + (r.to - r.from), 0);
  console.log(`${TARGET} owns ${own.length} region(s) of ${NOTE_STEP_REGION} bytes: ${total} of 160780 (${((total / 160780) * 100).toFixed(2)}%)`);
  console.log(`  of which only the ${NOTE_LANES.size} NOTE lanes are writable by this script (${((NOTE_LANES.size / 160780) * 100).toFixed(2)}% of the file)`);
  for (const t of OTHER_TRACKS) {
    const rs = trackRegions(t);
    if (rs.some((a) => own.some((c) => a.from < c.to && c.from < a.to))) { console.log(`  overlaps ${t}: YES - STOP`); process.exit(1); }
  }
  console.log(`  overlaps synth1 / synth2 / midi2: none`);
  console.log('');
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
const backupDir = `samples/circuit-ncs/restore-afterdark-midi1-octave-${stamp}`;
if (APPLY) mkdirSync(backupDir, { recursive: true });

console.log(`settling ${SETTLE_MS / 1000}s for the pack-manifest flush before the first read...`);
await sleep(SETTLE_MS);

let written = 0;
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
    console.log(`  ${tag}  REFUSED: name is "${nm}", expected "${expectName(slot)}".`);
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
console.log(`${APPLY ? 'APPLIED' : 'DRY RUN'}: ${written} project(s) transposed.`);
if (APPLY && backups.length > 0) {
  console.log('restore points:');
  for (const p of backups) console.log(`  ${p}`);
}
console.log('');
console.log('SCOPE NOTE: the verses (P2, P4) and the bridge (P7) still have NO midi1 content.');
console.log('Part 4 does carry different material there (48 / 48 / 53 onsets, A#2..D#3 and G2..D3),');
console.log('but back-filling it would run the VE-500 retune across the whole song, which the');
console.log('maintainer explicitly rejected. That is his call, not this script\'s.');
endMidiScript(0);
