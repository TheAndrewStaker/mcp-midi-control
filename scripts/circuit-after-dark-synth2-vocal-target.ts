/**
 * circuit-after-dark-synth2-vocal-target.ts: make **Synth 2** After Dark's
 * dedicated vocal pitch target on the three chorus projects, by copying MIDI 1's
 * melody onto it byte-for-byte. Replaces Synth 2's pad content, which is the
 * point.
 *
 * Build record: `docs/_private/rig/songs/after-dark.md`.
 * Precedent for the byte-surgical shape: `circuit-after-dark-midi1-octave-up.ts`.
 *
 * ## Why the vocal target has to move off MIDI 1
 *
 * Measured at the VE-500's own MIDI In, 2026-07-28: channels 1, 2, 4 and 10 all
 * arrive through the Circuit -> MicroFreak -> VE-500 chain, and **channel 3 does
 * not**. The MicroFreak's Input Chan is 3, so it ABSORBS its own receive channel
 * and relays everything else. MIDI 1 is ch3, so the line on it can reach the
 * MicroFreak OR the VE-500, never both. One track cannot be both the audible
 * lead and the retune target.
 *
 * The maintainer's fix, in his words: *"I believe Synth two is currently playing
 * the pads, and I would like to play this live because it's simple for me to do
 * myself. So let's replace the vocal melody on Synth two… I'm okay with it being
 * a dedicated vocal melody midi channel if that simplifies everything."*
 *
 * Synth 2 is ch2, which the MicroFreak passes through, and its stored mixer level
 * is already 0, so it makes no internal sound. That is exactly the shape of a
 * pure target track. **He plays the pads live**, which is why displacing them is
 * the request rather than a cost.
 *
 * ## Why this is a VERBATIM COPY and not an authoring pass
 *
 * The vocal target must ARRIVE at the VE-500 in his singing register, D#3..F4 =
 * MIDI 51..65 on the wire. The Circuit transmits **12 semitones below what it
 * stores** — measured on this card on both track kinds, not assumed:
 *
 *   - MIDI track: midi1 stored 51..65, arrived 39..53.
 *   - SYNTH track: synth1 (the bass) stored 39..43, arrived 27..31.
 *
 * Both are a constant -12 at both ends, so a synth track drops exactly as a MIDI
 * track does. Wire 51..65 therefore needs storage **63..77**, and MIDI 1 already
 * holds precisely 63..77 (84 notes, put there 2026-07-28 for this same reason).
 *
 * So Synth 2's content is MIDI 1's content at the SAME stored pitch: a byte copy,
 * with no pitch arithmetic anywhere in this script. That also settles the note
 * lengths for free. The VE-500 does not latch, so a retune target's note LENGTH
 * is the duration of the correction, and MIDI 1's gates were authored from the
 * source's own durations with 24 tie flags. A verbatim region copy carries gate,
 * tie, delay, velocity, slot mask and probability across unchanged; re-authoring
 * from the source would have had to reproduce them.
 *
 * ## What gets copied, and nothing else
 *
 * Three things, because a note region alone does not play:
 *
 *   1. midi1's 8 step regions (896 bytes each) -> synth2's 8 step regions.
 *   2. midi1's 8 pattern LENGTH bytes (byte 0 of each metadata block) ->
 *      synth2's. Without this a 32-step pattern plays only its first 16 steps.
 *   3. midi1's chain slot `[start, end]` at 0x2cc -> synth2's at 0x2c8. Without
 *      this synth2 loops pattern 1 forever instead of advancing 1..8.
 *
 * Every changed byte must land in that set or the run stops. synth1, midi1 and
 * midi2 must come back byte-identical, and so must the tempo, the name, the
 * scale and both mixer levels.
 *
 * ## Refusals (each one is a stop, never a retry)
 *
 *  - Bad CRC on the read.
 *  - Project name is not the expected `AfterDark P<n>`.
 *  - midi1 does not hold exactly 84 notes at `--expect-midi1` (default 63..77).
 *  - The project scale is not Chromatic (a non-Chromatic scale re-quantizes
 *    stored notes on playback, so the target would arrive on different pitches).
 *  - Any diff byte outside synth2's step regions, its 8 length bytes, or its
 *    2 chain bytes.
 *  - A backup path that already exists.
 *  - Any collateral byte, or any per-slot difference between synth2's decode and
 *    midi1's, on the independent read-back.
 *
 * Reads settle past the Circuit's 6-to-8s pack-manifest flush before the first
 * read and before every verify; a fast read reports stale state, and on a device
 * with no decoded erase that is the dangerous direction.
 *
 * Usage:
 *   npx tsx scripts/circuit-after-dark-synth2-vocal-target.ts            # dry run
 *   npx tsx scripts/circuit-after-dark-synth2-vocal-target.ts --apply
 */
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { connect } from '../packages/core/src/midi/transport.js';
import { endMidiScript, exitMidiScript, reconnectMidi } from './_lib/midi-lifecycle.js';
import { downloadProject, uploadProject } from '../packages/circuit-tracks/src/ncs/uploadProject.js';
import { decodeNotePattern, MAX_MIDI_NOTE, type NoteStep } from '../packages/circuit-tracks/src/ncs/notePattern.js';
import {
  noteStepBase, noteBlockIndex, META_OFFSETS, NOTE_STEP_REGION,
  PATTERNS_PER_TRACK, STEPS_PER_PATTERN, getProjectTempo,
  MIXER_SYNTH1_LEVEL, MIXER_SYNTH2_LEVEL, type NoteTrack,
} from '../packages/circuit-tracks/src/ncs/format.js';
import { SCALE_TYPE_OFFSET, SCALE_ROOT_OFFSET, SCALE_CHROMATIC, SCALE_NAMES } from '../packages/circuit-tracks/src/ncs/scale.js';

const argv = process.argv.slice(2);
const flag = (n: string): string | undefined => { const i = argv.indexOf(n); return i === -1 ? undefined : argv[i + 1]; };
const APPLY = argv.includes('--apply');
const devicePack = Number(flag('--pack') ?? '2');

const SRC: NoteTrack = 'midi1';
const DST: NoteTrack = 'synth2';
/** Must be byte-identical on read-back. `midi1` is the source and is also untouched. */
const UNTOUCHED: NoteTrack[] = ['synth1', 'midi1', 'midi2'];
const SLOTS = [3, 5, 8];
const EXPECT_NOTES = 84;
const NAME_OFF = 0x10;
const NAME_LEN = 0x20;
const CONNECT = { needles: ['circuit'], notFoundLeadIn: 'Circuit Tracks not found.' };

/** Shared chain table (chain.ts): 8 slots x 4 bytes at 0x2c4; synth2 = slot 1, midi1 = slot 2. */
const CHAIN_BASE = 0x2c4;
const CHAIN_STRIDE = 4;
const CHAIN_SLOT: Readonly<Record<NoteTrack, number>> = { synth1: 0, synth2: 1, midi1: 2, midi2: 3 };
const chainOffset = (t: NoteTrack): number => CHAIN_BASE + CHAIN_SLOT[t] * CHAIN_STRIDE;

/**
 * What midi1 is expected to hold BEFORE this run, as a claim the caller has to
 * get right. 63..77 is the 2026-07-28 read-back: the melody at the storage value
 * that arrives on the wire as 51..65, his singing register. A range that is not
 * the one named is a hard refusal, not a prompt to adapt.
 */
const EXPECT_RANGE = ((): { lo: number; hi: number } => {
  const raw = flag('--expect-midi1');
  if (raw === undefined) return { lo: 63, hi: 77 };
  const m = /^(\d+)\.\.(\d+)$/.exec(raw.trim());
  if (m === null) { console.error(`--expect-midi1 must look like "lo..hi", got "${raw}".`); process.exit(1); }
  const lo = Number(m[1]), hi = Number(m[2]);
  if (lo > hi || lo < 0 || hi > MAX_MIDI_NOTE) { console.error(`--expect-midi1 ${lo}..${hi} is not a usable range.`); process.exit(1); }
  return { lo, hi };
})();

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const pitchName = (p: number): string => `${NOTE_NAMES[((p % 12) + 12) % 12]}${Math.floor(p / 12) - 1}`;
const hex = (n: number): string => `0x${n.toString(16)}`;
const nameOf = (b: Uint8Array): string =>
  Array.from(b.slice(NAME_OFF, NAME_OFF + NAME_LEN)).map((c) => (c >= 32 && c < 127 ? String.fromCharCode(c) : '')).join('').trim();

const stepRegions = (t: NoteTrack): { from: number; to: number }[] =>
  Array.from({ length: PATTERNS_PER_TRACK }, (_, p) => {
    const from = noteStepBase(t, p);
    return { from, to: from + NOTE_STEP_REGION };
  });
const lengthOffsets = (t: NoteTrack): number[] =>
  Array.from({ length: PATTERNS_PER_TRACK }, (_, p) => META_OFFSETS[noteBlockIndex(t, p)]);

/** Every offset this script is allowed to change. Anything else is a refusal. */
const WRITABLE = ((): Set<number> => {
  const s = new Set<number>();
  for (const r of stepRegions(DST)) for (let i = r.from; i < r.to; i++) s.add(i);
  for (const o of lengthOffsets(DST)) s.add(o);
  s.add(chainOffset(DST)); s.add(chainOffset(DST) + 1);
  return s;
})();

interface Snapshot { steps: NoteStep[][]; notes: number[]; activeSteps: number; ties: number }
function snapshot(b: Uint8Array, track: NoteTrack): Snapshot {
  const steps: NoteStep[][] = [];
  const notes: number[] = [];
  let activeSteps = 0, ties = 0;
  for (let p = 0; p < PATTERNS_PER_TRACK; p++) {
    const decoded = decodeNotePattern(b, track, p);
    steps.push(decoded);
    for (const st of decoded) {
      if (st.notes.length > 0) activeSteps++;
      for (const sl of st.notes) { notes.push(sl.note); if (sl.tie) ties++; }
    }
  }
  return { steps, notes, activeSteps, ties };
}
const rangeOf = (n: number[]): string =>
  n.length === 0 ? '(empty)' : `${Math.min(...n)}..${Math.max(...n)} (${pitchName(Math.min(...n))}..${pitchName(Math.max(...n))})`;

/**
 * Per-slot decoded comparison of two tracks. This, not a byte diff, is the proof
 * that the copy is the same MUSIC: it walks every step and every note slot and
 * compares note, gate, tie, delay, velocity, mask and probability by name.
 */
function diffTracks(a: Snapshot, b: Snapshot, la: string, lb: string): string[] {
  const bad: string[] = [];
  for (let p = 0; p < PATTERNS_PER_TRACK; p++) {
    for (let s = 0; s < STEPS_PER_PATTERN; s++) {
      const x = a.steps[p][s], y = b.steps[p][s];
      if (x.slotMask !== y.slotMask) bad.push(`p${p + 1}s${s} slotMask ${la}=${x.slotMask} ${lb}=${y.slotMask}`);
      if (x.probability !== y.probability) bad.push(`p${p + 1}s${s} probability ${la}=${x.probability} ${lb}=${y.probability}`);
      if (x.notes.length !== y.notes.length) { bad.push(`p${p + 1}s${s} note count ${la}=${x.notes.length} ${lb}=${y.notes.length}`); continue; }
      for (let i = 0; i < x.notes.length; i++) {
        const u = x.notes[i], v = y.notes[i];
        if (u.note !== v.note) bad.push(`p${p + 1}s${s}n${i} note ${la}=${u.note} ${lb}=${v.note}`);
        if (u.gate !== v.gate) bad.push(`p${p + 1}s${s}n${i} gate ${la}=${u.gate} ${lb}=${v.gate}`);
        if (u.tie !== v.tie) bad.push(`p${p + 1}s${s}n${i} tie ${la}=${u.tie} ${lb}=${v.tie}`);
        if (u.delay !== v.delay) bad.push(`p${p + 1}s${s}n${i} delay ${la}=${u.delay} ${lb}=${v.delay}`);
        if (u.velocity !== v.velocity) bad.push(`p${p + 1}s${s}n${i} velocity ${la}=${u.velocity} ${lb}=${v.velocity}`);
      }
    }
  }
  return bad;
}

interface Plan { after: Uint8Array; edits: number[]; refusal?: string }
function planCopy(before: Uint8Array): Plan {
  const after = new Uint8Array(before);
  const src = stepRegions(SRC), dst = stepRegions(DST);
  for (let p = 0; p < PATTERNS_PER_TRACK; p++) {
    after.set(before.subarray(src[p].from, src[p].to), dst[p].from);
    after[lengthOffsets(DST)[p]] = before[lengthOffsets(SRC)[p]];
  }
  after[chainOffset(DST)] = before[chainOffset(SRC)];
  after[chainOffset(DST) + 1] = before[chainOffset(SRC) + 1];

  const edits: number[] = [];
  for (let i = 0; i < before.length; i++) {
    if (before[i] === after[i]) continue;
    if (!WRITABLE.has(i)) return { after, edits, refusal: `planned edit at ${hex(i)} is outside ${DST}'s step regions / length bytes / chain slot.` };
    edits.push(i);
  }
  return { after, edits };
}

function preflight(b: Uint8Array, slot: number): string | undefined {
  const nm = nameOf(b);
  if (nm !== `AfterDark P${slot}`) return `name is "${nm}", expected "AfterDark P${slot}".`;
  const scale = b[SCALE_TYPE_OFFSET];
  if (scale !== SCALE_CHROMATIC) {
    return `project scale is ${scale} (${SCALE_NAMES[scale] ?? '?'}), not Chromatic. A non-Chromatic scale re-quantizes stored notes on playback, so the retune target would arrive on different pitches.`;
  }
  const src = snapshot(b, SRC);
  if (src.notes.length !== EXPECT_NOTES) return `${SRC} holds ${src.notes.length} note(s), expected ${EXPECT_NOTES}.`;
  const lo = Math.min(...src.notes), hi = Math.max(...src.notes);
  if (lo !== EXPECT_RANGE.lo || hi !== EXPECT_RANGE.hi) {
    return `${SRC} range is ${lo}..${hi} (${pitchName(lo)}..${pitchName(hi)}), expected ${EXPECT_RANGE.lo}..${EXPECT_RANGE.hi}`
      + `${flag('--expect-midi1') === undefined ? ' (the 2026-07-28 read-back; pass --expect-midi1 lo..hi if the card has moved since)' : ' (from --expect-midi1)'}.`
      + ` Copying a melody that is not in the expected register would put the retune target in the wrong octave. Not guessing.`;
  }
  return undefined;
}

// ── header ───────────────────────────────────────────────────────────
console.log(`After Dark: Synth 2 becomes the DEDICATED VOCAL PITCH TARGET (ch2)`);
console.log(`Pack ${devicePack}, the three chorus projects ${SLOTS.join(',')} ("AfterDark P3", "P5", "P8")`);
console.log(`Copying ${SRC} -> ${DST} VERBATIM at stored ${EXPECT_RANGE.lo}..${EXPECT_RANGE.hi} (${pitchName(EXPECT_RANGE.lo)}..${pitchName(EXPECT_RANGE.hi)})`);
console.log(`  the Circuit transmits 12 semitones BELOW what it stores (measured on this card: midi1 51..65 -> wire 39..53; synth1 39..43 -> wire 27..31),`);
console.log(`  so stored ${EXPECT_RANGE.lo}..${EXPECT_RANGE.hi} arrives at the VE-500 as ${EXPECT_RANGE.lo - 12}..${EXPECT_RANGE.hi - 12} (${pitchName(EXPECT_RANGE.lo - 12)}..${pitchName(EXPECT_RANGE.hi - 12)}), his singing register`);
console.log(`  ch3 is absorbed by the MicroFreak (its Input Chan); ch2 is relayed, so ${DST} is the only track that reaches BOTH ends`);
console.log(`SYNTH 2's PAD CONTENT IS REPLACED. That is the request: he plays the pads live.`);
console.log(`Synth 1, MIDI 1, MIDI 2, the drums, the tempo, the scale and the mixer levels are NOT touched.`);
console.log(APPLY ? 'MODE: APPLY' : 'MODE: DRY RUN (nothing will be written)');
console.log('');
{
  const dstR = stepRegions(DST);
  for (const t of UNTOUCHED) {
    if (stepRegions(t).some((a) => dstR.some((c) => a.from < c.to && c.from < a.to))) { console.log(`  ${DST} overlaps ${t}: YES - STOP`); process.exit(1); }
  }
  console.log(`${DST} writable set: ${PATTERNS_PER_TRACK} x ${NOTE_STEP_REGION} step bytes + ${PATTERNS_PER_TRACK} length bytes + 2 chain bytes = ${WRITABLE.size} of 160780 (${((WRITABLE.size / 160780) * 100).toFixed(2)}%)`);
  console.log(`  chain: ${DST} slot ${hex(chainOffset(DST))} <- ${SRC} slot ${hex(chainOffset(SRC))};  overlaps synth1 / midi1 / midi2: none`);
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
const backupDir = `samples/circuit-ncs/restore-afterdark-synth2-vocal-${stamp}`;
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
  const srcSnap = snapshot(before, SRC);
  const dstSnap = snapshot(before, DST);
  console.log(`  ${tag}  "${nameOf(before)}"  CRC ok  tempo ${getProjectTempo(before)} BPM  scale ${SCALE_NAMES[before[SCALE_TYPE_OFFSET]] ?? '?'} root ${before[SCALE_ROOT_OFFSET]}  mixer synth1=${before[MIXER_SYNTH1_LEVEL]} synth2=${before[MIXER_SYNTH2_LEVEL]}`);
  console.log(`        ${SRC} (source)   ${String(srcSnap.notes.length).padStart(3)} notes ${rangeOf(srcSnap.notes)} over ${srcSnap.activeSteps} step(s), ${srcSnap.ties} tied`);
  console.log(`        ${DST} (WILL BE REPLACED) ${String(dstSnap.notes.length).padStart(3)} notes ${rangeOf(dstSnap.notes)} over ${dstSnap.activeSteps} step(s), ${dstSnap.ties} tied  <- the pad`);

  const refusal = preflight(before, slot);
  if (refusal !== undefined) {
    console.log(`        REFUSED: ${refusal}`);
    console.log(`\nFAIL-STOP after ${written} write(s). Projects from ${slot} on are UNTOUCHED.`);
    exitMidiScript(1);
  }

  const plan = planCopy(before);
  if (plan.refusal !== undefined) {
    console.log(`        REFUSED: ${plan.refusal}`);
    exitMidiScript(1);
  }
  const planned = snapshot(plan.after, DST);
  const drift = diffTracks(srcSnap, planned, SRC, DST);
  if (drift.length > 0) {
    console.log(`        REFUSED: planned ${DST} differs from ${SRC} in ${drift.length} place(s): ${drift.slice(0, 4).join('; ')}`);
    exitMidiScript(1);
  }
  if (plan.edits.length === 0) {
    console.log(`        already identical to ${SRC}; nothing to write.`);
    continue;
  }
  const lens = lengthOffsets(DST).map((o, i) => `${plan.after[o]}<-${before[lengthOffsets(SRC)[i]]}`);
  console.log(`        plan: ${plan.edits.length} byte(s) -> ${DST} ${planned.notes.length} notes ${rangeOf(planned.notes)}, ${planned.ties} tied, ${planned.activeSteps} step(s); per-slot decode identical to ${SRC}`);
  console.log(`              pattern lengths ${lens.join(' ')} (steps-1); chain [${plan.after[chainOffset(DST)]},${plan.after[chainOffset(DST) + 1]}] <- ${SRC} [${before[chainOffset(SRC)]},${before[chainOffset(SRC) + 1]}]`);

  if (!APPLY) continue;

  const backup = `${backupDir}/pack${devicePack}-proj${String(slot).padStart(2, '0')}.ncs`;
  if (existsSync(backup)) { console.log(`        REFUSED: backup ${backup} already exists.`); exitMidiScript(1); }
  writeFileSync(backup, before);
  backups.push(backup);
  console.log(`        backup: ${backup} (${before.length} bytes, full pre-edit project incl. the displaced pad)`);

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
  const got = v.bytes;
  const intended = new Set(plan.edits);
  const wrong: string[] = [], collateral: number[] = [];
  for (let i = 0; i < before.length; i++) {
    if (intended.has(i)) { if (got[i] !== plan.after[i]) wrong.push(`${hex(i)}=${got[i]} (wanted ${plan.after[i]})`); }
    else if (got[i] !== before[i]) collateral.push(i);
  }
  const backDst = snapshot(got, DST);
  const backSrc = snapshot(got, SRC);
  const perSlot = diffTracks(backSrc, backDst, SRC, DST);
  const others: string[] = [];
  for (const t of UNTOUCHED) {
    let diff = 0;
    for (const rr of stepRegions(t)) for (let i = rr.from; i < rr.to; i++) if (got[i] !== before[i]) diff++;
    others.push(`${t} ${diff === 0 ? 'identical' : `${diff} BYTES CHANGED`}`);
  }
  const nameBack = nameOf(got), tempoBack = getProjectTempo(got);
  const mixOk = got[MIXER_SYNTH1_LEVEL] === before[MIXER_SYNTH1_LEVEL] && got[MIXER_SYNTH2_LEVEL] === before[MIXER_SYNTH2_LEVEL];
  const scaleOk = got[SCALE_TYPE_OFFSET] === before[SCALE_TYPE_OFFSET] && got[SCALE_ROOT_OFFSET] === before[SCALE_ROOT_OFFSET];
  console.log(`        read-back: ${plan.edits.length - wrong.length}/${plan.edits.length} intended byte(s) landed, collateral ${collateral.length}`);
  console.log(`                   ${DST} ${backDst.notes.length} notes ${rangeOf(backDst.notes)}, ${backDst.ties} tied, ${backDst.activeSteps} step(s); per-slot vs ${SRC}: ${perSlot.length === 0 ? 'IDENTICAL' : perSlot.slice(0, 4).join('; ')}`);
  console.log(`                   ${others.join(' | ')}  |  name "${nameBack}"  tempo ${tempoBack}  scale ${SCALE_NAMES[got[SCALE_TYPE_OFFSET]] ?? '?'}  mixer synth1=${got[MIXER_SYNTH1_LEVEL]} synth2=${got[MIXER_SYNTH2_LEVEL]}`);
  if (wrong.length > 0 || collateral.length > 0 || perSlot.length > 0 || nameBack !== nameOf(before)
      || tempoBack !== getProjectTempo(before) || !mixOk || !scaleOk) {
    console.log(`        VERIFY FAILED: ${wrong.length} wrong (${wrong.slice(0, 4).join(', ')}), collateral at ${collateral.slice(0, 6).map(hex).join(', ')}`);
    console.log(`        restore with ${backup}`);
    exitMidiScript(1);
  }
  console.log(`        PASS: ${plan.edits.length} byte(s) of ${before.length} changed, all inside ${DST}, ZERO collateral.`);
  written++;
  await sleep(400);
}

console.log('');
console.log(`${APPLY ? 'APPLIED' : 'DRY RUN'}: ${written} project(s) given the Synth 2 vocal target.`);
if (APPLY && backups.length > 0) {
  console.log('restore points (each holds the displaced pad):');
  for (const p of backups) console.log(`  ${p}`);
}
console.log('');
console.log(`NEXT: re-pitch ${SRC} down to the audible lead's own register, which is a SEPARATE run:`);
console.log(`  npx tsx scripts/circuit-after-dark-midi1-octave-up.ts --expect ${EXPECT_RANGE.lo}..${EXPECT_RANGE.hi} --transpose -12 --apply`);
console.log(`Run it AFTER this one: it moves the source, and the copy above must be taken at ${EXPECT_RANGE.lo}..${EXPECT_RANGE.hi}.`);
endMidiScript(0);
